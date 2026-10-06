/* public/grounding.js
 * Keeps report recommendations honest about the customer's own website.
 *
 * On 2026-10-06 a customer was told to create an llms.txt they already had.
 * The report had never looked at the site, and the plan prompt even named
 * llms.txt as an example lever. Two rules now apply to every report:
 *   1. The plan is written from a live site check (api/site-check.js), and
 *      the prompt says what exists, what is missing and what couldn't be checked.
 *   2. Every generated item then passes through groundItems() below. Anything
 *      that recommends creating something the site already has, or that
 *      depends on something we couldn't verify, is removed before the
 *      customer sees it.
 * Loaded by the report pages as a plain script; also require()-able for tests.
 */
(function (root) {
  'use strict';
  var G = {};

  var CREATE = /\b(add|adding|create|creating|deploy|deploying|publish|publishing|implement|implementing|set ?up|setting up|build|building|launch|launching|write|writing|install|installing|upload|uploading|introduce|introducing|generate|generating|draft|drafting|claim|claiming|establish|establishing|place|start|starting|get listed|list your|submit|submitting|roll out|stand up|spin up|put up)\b/i;
  var IMPROVE = /\b(update|updating|expand|expanding|refresh|refreshing|improve|improving|strengthen|strengthening|extend|extending|enrich|enriching|revise|revising|tighten|tightening|maintain|maintaining|optimi[sz]e|optimi[sz]ing|already (have|has|live|exists?)|existing|keep (it|your) .{0,30}current)\b/i;

  var BOT_LABELS = ['GPTBot', 'OAI-SearchBot', 'PerplexityBot', 'ClaudeBot', 'Google-Extended'];

  function st(x) { return (x && x.status) || 'unknown'; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function listJoin(a) { return a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  function blockedBots(f) {
    var b = (f && f.robots && f.robots.bots) || {};
    return Object.keys(b).filter(function (k) { return b[k].status === 'blocked'; });
  }
  function pagesOf(f, kind) { return (f && f.pages && f.pages.pages && f.pages.pages[kind]) || []; }
  function countOf(f, kind) { return (f && f.pages && f.pages.counts && f.pages.counts[kind]) || 0; }
  function pathOf(u) { try { return new URL(u).pathname; } catch (e) { return u; } }
  // The page list (paths) is only kept while the plan is written; saved
  // reports keep the counts. Comparison checks need the paths themselves.
  function hasPaths(f) { return !!(f && f.paths && f.paths.length); }
  function hasInventory(f) { return hasPaths(f) || !!(f && f.pages && f.pages.inventoryCount); }
  function n(x) { return Number(x || 0).toLocaleString('en-US'); }

  // Organization has many subtypes; a site using one of them has Organization markup.
  var SCHEMA = [
    { type: 'FAQPage',             re: /\bFAQ ?Page\b|\bFAQ (schema|markup|structured data)\b/i, also: [] },
    { type: 'Organization',        re: /\bOrgani[sz]ation (schema|markup|structured data)\b/i, also: ['Corporation', 'EducationalOrganization', 'LocalBusiness', 'NGO', 'OnlineBusiness', 'ProfessionalService', 'NewsMediaOrganization'] },
    { type: 'Product',             re: /\bProduct (schema|markup|structured data)\b/i, also: ['ProductGroup', 'IndividualProduct'], pageKind: 'offering' },
    { type: 'Course',              re: /\bCourse (schema|markup|structured data)\b/i, also: ['CourseInstance'], pageKind: 'offering' },
    { type: 'SoftwareApplication', re: /\bSoftwareApplication\b/i, also: ['WebApplication', 'MobileApplication'], pageKind: 'offering' },
    { type: 'Service',             re: /\bService (schema|markup|structured data)\b/i, also: ['ProfessionalService'], pageKind: 'offering' },
    { type: 'ProfessionalService', re: /\bProfessionalService\b/i, also: [] },
    { type: 'LocalBusiness',       re: /\bLocalBusiness\b/i, also: [] },
    { type: 'HowTo',               re: /\bHowTo\b/i, also: [], pageKind: 'blog' },
    { type: 'AggregateRating',     re: /\b(AggregateRating|Review (schema|markup))\b/i, also: ['Review'] },
    { type: 'Article',             re: /\b(Article|BlogPosting) (schema|markup|structured data)\b/i, also: ['BlogPosting', 'NewsArticle'], pageKind: 'blog' },
    { type: 'BreadcrumbList',      re: /\bBreadcrumb(List)?\b/i, also: [] },
    { type: 'Event',               re: /\bEvent (schema|markup|structured data)\b/i, also: ['EducationEvent', 'BusinessEvent'], pageKind: 'offering' },
    { type: 'Person',              re: /\bPerson (schema|markup|structured data)\b/i, also: [] },
    { type: 'WebSite',             re: /\bWebSite (schema|markup|structured data)\b/i, also: [] },
  ];
  var GENERIC_SCHEMA = /\b(schema\.org|schema markup|structured data|json-ld|rich results?)\b/i;

  // Review sites and directories. Only recommended when AI actually read them.
  var DIRS = [
    { re: /\bG2(\.com)?\b/, domain: 'g2.com' },
    { re: /\bCapterra\b/i, domain: 'capterra.com' },
    { re: /\bTrustRadius\b/i, domain: 'trustradius.com' },
    { re: /\bClutch(\.co)?\b/, domain: 'clutch.co' },
    { re: /\bProduct ?Hunt\b/i, domain: 'producthunt.com' },
    { re: /\bGetApp\b/i, domain: 'getapp.com' },
    { re: /\bSoftware Advice\b/i, domain: 'softwareadvice.com' },
    { re: /\bCrunchbase\b/i, domain: 'crunchbase.com' },
    { re: /\bTrustpilot\b/i, domain: 'trustpilot.com' },
    { re: /\bYelp\b/i, domain: 'yelp.com' },
    { re: /\bGartner Peer Insights\b/i, domain: 'gartner.com' },
    { re: /\beLearning Industry\b/i, domain: 'elearningindustry.com' },
    { re: /\bTraining Industry\b/i, domain: 'trainingindustry.com' },
    { re: /\bCampus Technology\b/i, domain: 'campustechnology.com' },
    { re: /\bWikipedia\b/i, domain: 'wikipedia.org' },
    { re: /\bAngi\b|\bAngie'?s List\b/i, domain: 'angi.com' },
    { re: /\bHomeAdvisor\b/i, domain: 'homeadvisor.com' },
    { re: /\bThumbtack\b/i, domain: 'thumbtack.com' },
    { re: /\bBBB\b|Better Business Bureau/i, domain: 'bbb.org' },
  ];

  var GENERIC_WORDS = /^(the|and|for|inc|llc|ltd|group|company|co|corp|learning|training|institute|center|centre|academy|solutions|services|consulting|partners|global|international|systems|software|technologies|labs?)$/i;
  function slugWords(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(function (w) { return w.length >= 3 && !GENERIC_WORDS.test(w); });
  }

  // Match a buyer question to an existing page by the words in its URL path,
  // e.g. "best crucial conversations training" -> /solutions/crucial-conversations-for-dialogue/.
  var STOP = /^(the|and|for|with|from|that|this|what|which|who|how|best|top|good|great|near|me|my|your|our|you|are|is|can|does|do|vs|versus|online|free|cheap|get|find|need|should|i|a|an|of|to|in|on|or|by|why|when|where|it|its|any|most|more|than|program|programs|company|companies|service|services)$/;
  function toks(str) {
    return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter(function (w) { return w.length >= 3 && !STOP.test(w); })
      .map(function (w) { return w.length > 4 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w; });
  }
  // Words that describe the format, not the topic. A path sharing only these
  // with a question ("training", "managers") doesn't cover that question.
  var GENERICISH = /^(training|train|course|class|workshop|seminar|certification|certificate|guide|tip|team|leader|leadership|manager|employee|staff|corporate|business|professional|skill|learning|solution|option|provider|vendor|tool|software|platform|price|pricing|cost|review|example|template)$/;
  // Blog posts, ebooks and similar are not the buyer page a question needs.
  var NOT_BUYER_PAGE = /(^|\/)(blog|news|articles?|insights|posts?|press|podcasts?|webinars?|events?|careers?|jobs?|tag|category|author|lp)(\/|$)|ebook|download|whitepaper/;
  var OFFERING_PAGE = /(^|\/)(solutions?|courses?|training|programs?|services?|products?|offerings?|workshops?|certifications?)(\/|$)/;
  function bestPage(phrase, f) {
    var q = toks(phrase);
    var core = q.filter(function (w) { return !GENERICISH.test(w); });
    if (!core.length || !hasPaths(f)) return null;
    var best = null;
    f.paths.forEach(function (p) {
      if (NOT_BUYER_PAGE.test(p) || p === '/') return;
      var pt = toks(p.replace(/[\/\-_.]+/g, ' '));
      if (!core.every(function (w) { return pt.indexOf(w) >= 0; })) return;
      var hit = q.filter(function (w) { return pt.indexOf(w) >= 0; }).length;
      // Prefer the page that sells the thing (solutions, courses, services)
      // over a book or resource page with the same words.
      var score = hit * 10 + (OFFERING_PAGE.test(p) ? 5 : 0) - p.length / 1000;
      if (!best || score > best.score) best = { path: p, score: score };
    });
    return best && best.path;
  }
  G.bestPage = bestPage;

  function sourcesInclude(domains, d) {
    return (domains || []).some(function (x) { x = String(x).toLowerCase(); return x === d || x.slice(-(d.length + 1)) === '.' + d; });
  }

  function creates(text) { return CREATE.test(text) && !IMPROVE.test(text); }

  // Returns a reason string if the item contradicts or can't be supported by
  // the site facts, otherwise null.
  function problem(text, f, ctx) {
    var t = String(text || '');
    ctx = ctx || {};
    var siteOk = !!(f && f.reachable);

    // llms.txt / llms-full.txt
    if (/llms(-full)?\.txt|\bllms\s+(file|text)/i.test(t)) {
      var fullOnly = /llms-full\.txt/i.test(t) && !/llms\.txt(?!-)/i.test(t.replace(/llms-full\.txt/ig, ''));
      var s = st(fullOnly ? f && f.llmsFull : f && f.llms);
      if (s === 'unknown') return 'Could not check llms.txt on the site';
      if (s === 'present' && creates(t)) return 'Site already has ' + (fullOnly ? 'llms-full.txt' : 'llms.txt');
      // We don't read what an existing llms.txt lists, so "add X to it" can't be
      // verified. The site check section already says to keep it current.
      if (s === 'present') return 'llms.txt is already in place; edits to it are covered in the site check';
    }

    // robots.txt and AI crawler access
    if (/\b(gptbot|oai-searchbot|perplexitybot|claudebot|google-extended|ai crawlers?|ai bots?|robots\.txt)\b/i.test(t)) {
      if (st(f && f.robots) === 'unknown') return 'Could not check robots.txt';
      if (/\b(allow|unblock|permit|open up|let)\b/i.test(t) && blockedBots(f).length === 0) return 'robots.txt already allows the AI crawlers';
      if (/robots\.txt/i.test(t) && /\b(create|add|publish|set up)\b[^.]{0,30}robots\.txt/i.test(t) && st(f.robots) === 'present') return 'Site already has robots.txt';
    }

    // XML sitemap
    if (/\bsitemap\b/i.test(t) && /\b(create|generate|add|build|publish|set up)\b[^.]{0,40}\bsitemap\b/i.test(t)) {
      if (st(f && f.sitemap) === 'unknown') return 'Could not check the sitemap';
      if (st(f.sitemap) === 'present') return 'Site already has an XML sitemap';
    }

    // Schema.org types that don't exist
    var fake = invalidSchemaType(t);
    if (fake) return fake + ' is not a schema.org type';

    // Schema.org markup
    var mentioned = SCHEMA.filter(function (s) { return s.re.test(t); });
    if (mentioned.length || GENERIC_SCHEMA.test(t)) {
      var sch = (f && f.schema) || {};
      if (sch.status !== 'checked') return 'Could not check the site’s schema markup';
      var found = sch.types || [];
      for (var i = 0; i < mentioned.length; i++) {
        var m = mentioned[i];
        var has = [m.type].concat(m.also).some(function (x) { return found.indexOf(x) >= 0; });
        if (has && creates(t)) return 'Site already has ' + m.type + ' markup';
        if (!has && m.pageKind && (sch.sampledKinds || []).indexOf(m.pageKind) < 0) return 'Could not check ' + m.type + ' markup (no matching page was sampled)';
      }
      if (!mentioned.length && creates(t) && found.length && !/\bto (your|the) [a-z0-9 \-]{2,40} page/i.test(t)) return 'Unspecific schema advice on a site that already has structured data';
    }

    // Comparison pages against named competitors
    if (/\b(vs\.?|versus|comparison|compare|alternatives?)\b/i.test(t) && creates(t)) {
      var comps = (ctx.competitors || []).filter(function (c) { return c && t.toLowerCase().indexOf(String(c).toLowerCase()) >= 0; });
      if (comps.length) {
        if (!hasPaths(f)) return 'Could not check existing pages for a comparison page';
        for (var j = 0; j < comps.length; j++) {
          var words = slugWords(comps[j]);
          var slug = words.join('-');
          var hit = (f.paths || []).find(function (p) {
            return (slug && p.indexOf(slug) >= 0) || (words[0] && p.indexOf(words[0]) >= 0 && /(^|[\/\-_])(vs|versus|alternatives?|compare|comparison)([\/\-_.]|$)/.test(p));
          });
          if (hit) return 'Site already has a page covering ' + comps[j] + ' (' + hit + ')';
        }
      }
    }

    // New pages for a question the site already has a page for
    if (creates(t) && /\b(page|article|guide|post|landing page|resource)\b/i.test(t)) {
      var quoted = (t.match(/["\u201c]([^"\u201d]{6,120})["\u201d]/g) || []).map(function (x) { return x.slice(1, -1); });
      for (var qi = 0; qi < quoted.length; qi++) {
        if ((ctx.competitors || []).some(function (c) { return quoted[qi].toLowerCase().indexOf(String(c).toLowerCase()) >= 0; })) continue;
        var ex = bestPage(quoted[qi], f || {});
        if (ex) return 'An existing page already covers "' + quoted[qi] + '" (' + ex + ')';
      }
    }

    // FAQ / help pages
    if (/\b(FAQ|frequently asked questions) (page|hub|center|centre|library)\b|\bhelp center\b/i.test(t) && creates(t)) {
      if ((f && f.helpSites || []).length) return 'Site already has a help center (' + f.helpSites[0] + ')';
      if (!hasInventory(f)) return 'Could not check existing pages for an FAQ page';
      if (countOf(f, 'faq') > 0) return 'Site already has FAQ or help pages (' + pathOf(pagesOf(f, 'faq')[0]) + ')';
    }

    if (/\b(no|zero|none|lacks?|missing|without)\b[^.]{0,40}\b(FAQ|help)\b/i.test(t) && (f && f.helpSites || []).length) return 'Claims there are no FAQ or help pages, but the site has a help center (' + f.helpSites[0] + ')';

    // Pricing page
    if (/\b(create|publish|build|add|launch|put up)\b (a |an )?([a-z]+ ){0,2}pricing page\b/i.test(t)) {
      if (!hasInventory(f)) return 'Could not check existing pages for a pricing page';
      if (countOf(f, 'pricing') > 0) return 'Site already has a pricing page (' + pathOf(pagesOf(f, 'pricing')[0]) + ')';
    }

    // Case study hub
    if (/\b(create|publish|build|launch|add|start)\b (a |an )?([a-z]+ ){0,2}(case[- ]stud(y|ies)|customer stor(y|ies)|success stor(y|ies)) (page|hub|library|section|center)\b/i.test(t)) {
      if (!hasInventory(f)) return 'Could not check existing pages for case studies';
      if (countOf(f, 'caseStudies') > 0) return 'Site already has case studies (' + pathOf(pagesOf(f, 'caseStudies')[0]) + ')';
    }

    // Wikidata: never a plan item. Its notability rules need independent
    // published sources, and self-created company entries get deleted. The
    // site check text covers it as a later step.
    if (/\bwikidata\b/i.test(t)) return 'Wikidata needs independent coverage first; covered in the site check, not the plan';

    // Outreach to a competitor's own site (e.g. a guest post on radicalcandor.com).
    var doms = t.toLowerCase().match(/\b[a-z0-9-]+\.(?:org|com|net|io|co|edu|ai)\b/g) || [];
    for (var di = 0; di < doms.length; di++) {
      var root = doms[di].split('.')[0].replace(/-/g, '');
      var rival = (ctx.competitors || []).find(function (c) { var w = slugWords(c).join(''); return w.length >= 5 && (root === w || root.indexOf(w) === 0 || (w.indexOf(root) === 0 && root.length >= 6)); });
      if (rival && /\b(pitch|guest|contribut|partner|reach out|outreach|byline|co-?author|link from)/i.test(t)) return 'Recommends outreach to a competitor\u2019s site (' + doms[di] + ', ' + rival + ')';
    }
    // Press-release wires are paid distribution, not publications to pitch.
    if (/\b(prnewswire|pr newswire|businesswire|business wire|globenewswire)\b/i.test(t) && /\b(pitch|byline|contribut|guest)/i.test(t)) return 'Press-release wires are paid distribution, not a publication to pitch';
    if (/\breddit\b/i.test(t) && /\b(byline|bylined|pitch)/i.test(t)) return 'Reddit takes participation, not pitched or bylined articles';

    // Google Business Profile: only for businesses with local buyers.
    if (/google business profile|google my business|\bGBP\b/i.test(t) && !ctx.local) return 'Google Business Profile only applies to businesses with local buyers';

    // Review sites and directories: only the ones AI actually read.
    for (var k = 0; k < DIRS.length; k++) {
      if (DIRS[k].re.test(t) && !sourcesInclude(ctx.sourceDomains, DIRS[k].domain)) return DIRS[k].domain + ' was not among the sources AI read for these questions';
    }

    if (!siteOk && /\b(your|the) (site|website|homepage|pages?)\b/i.test(t) && /\b(markup|schema|llms|robots|sitemap|crawl)/i.test(t)) return 'Site could not be reached to verify';
    return null;
  }

  G.problem = problem;

  // One competitor, one name: "Dale Carnegie Training" -> "Dale Carnegie"
  // when both appear. Mutates results in place.
  var SUFFIX = /^(training|learning|inc|llc|ltd|co|corp|corporation|company|group|international|global|institute|consulting|solutions|associates)$/i;
  G.mergeCompetitorNames = function (results) {
    var all = {};
    (results || []).forEach(function (r) { (r.competitors_mentioned || []).forEach(function (n) { all[n] = 1; }); });
    var names = Object.keys(all), map = {};
    names.forEach(function (n) {
      names.forEach(function (m) {
        if (n === m || m.length >= n.length) return;
        var rest = n.slice(m.length).trim().replace(/^[,&]\s*/, '');
        if (n.toLowerCase().indexOf(m.toLowerCase() + ' ') === 0 && rest && rest.split(/\s+/).every(function (w) { return SUFFIX.test(w.replace(/[.,]/g, '')); })) {
          if (!map[n] || map[n].length > m.length) map[n] = m;
        }
      });
    });
    (results || []).forEach(function (r) {
      if (!r.competitors_mentioned) return;
      var seen = {};
      r.competitors_mentioned = r.competitors_mentioned.map(function (n) { return map[n] || n; }).filter(function (n) { if (seen[n]) return false; seen[n] = 1; return true; });
    });
    return map;
  };

  // Real schema.org types a plan might reasonably name. A CamelCase word used
  // as a type that isn't here (e.g. "CaseStudy schema") is invented.
  var VALID_TYPES = ('Thing Action CreativeWork Organization Corporation EducationalOrganization CollegeOrUniversity LocalBusiness ProfessionalService OnlineBusiness NGO ' +
    'WebSite WebPage AboutPage ContactPage CollectionPage ProfilePage ItemPage FAQPage QAPage Question Answer HowTo HowToStep Product ProductGroup Offer AggregateOffer ' +
    'Service Course CourseInstance EducationalOccupationalProgram EducationEvent Event BusinessEvent Person Review AggregateRating Rating Article BlogPosting NewsArticle ' +
    'TechArticle Report ScholarlyArticle Dataset BreadcrumbList ItemList ListItem VideoObject ImageObject AudioObject PodcastEpisode SoftwareApplication WebApplication ' +
    'MobileApplication Brand Place PostalAddress ContactPoint SearchAction SiteNavigationElement Book Occupation JobPosting Recipe MedicalOrganization MedicalClinic Hospital ' +
    'Physician Dentist LegalService Attorney AccountingService FinancialService FinancialProduct InsuranceAgency RealEstateAgent HomeAndConstructionBusiness Plumber ' +
    'Electrician HVACBusiness RoofingContractor GeneralContractor Restaurant Store AutoDealer AutoRepair SpeakableSpecification ClaimReview DefinedTerm DefinedTermSet ' +
    'OfferCatalog Certification EducationalOccupationalCredential Audience BusinessAudience MonetaryAmount PriceSpecification Trip TouristAttraction LodgingBusiness Hotel ' +
    'SportsActivityLocation ExerciseGym HealthAndBeautyBusiness ChildCare School Preschool ElementarySchool HighSchool EmployerAggregateRating WebContent').split(/\s+/);
  function invalidSchemaType(t) {
    var re = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b(?=(?:\s+(?:and|or|,)?\s*[A-Z][A-Za-z]+){0,3}\s+(?:schema|markup|structured data|type|JSON-LD))/g, m;
    while ((m = re.exec(t))) { if (VALID_TYPES.indexOf(m[1]) < 0) return m[1]; }
    var re2 = /\b(?:schema|markup|types?)\s*(?:types?)?\s*(?:like|such as|e\.g\.,?|including|:)\s*([A-Z][A-Za-z]+(?:\s*(?:,|and|or)\s*[A-Z][A-Za-z]+)*)/g;
    while ((m = re2.exec(t))) {
      var names = m[1].split(/\s*(?:,|and|or)\s*/);
      for (var i = 0; i < names.length; i++) if (/^[A-Z][a-z]+[A-Z]/.test(names[i]) && VALID_TYPES.indexOf(names[i]) < 0) return names[i];
    }
    return null;
  }
  G.invalidSchemaType = invalidSchemaType;

  // Claims about competitors' own sites ("X already carries Course schema",
  // "Y publishes case studies AI can parse") were never checked. Remove those
  // sentences; keep the rest of the item.
  G.stripUnverified = function (text, competitors) {
    var src = String(text || '');
    var tagM = src.match(/\s*\(Effort:[^)]*\)\s*$/);
    var body = tagM ? src.slice(0, tagM.index) : src;
    // Protect abbreviations and decimals so "e.g." or "3.5" don't end a sentence.
    var safe = body.replace(/\b(e\.g|i\.e|etc|vs|approx|incl|U\.S|No)\./gi, function (m) { return m.replace(/\./g, '\u0000'); })
                   .replace(/(\d)\.(\d)/g, '$1\u0000$2');
    var sentences = safe.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [safe];
    if (sentences.length < 2) return src;
    var claim = /\b(schema|markup|structured data|json-ld|format(s|ted)?|publish(es|ing)?|carry|carries|deploy(s|ed)?|already (benefit\w*|us\w*|ha(ve|s))|benefit(s|ing)? from|parse|parseable|structured signals?)\b/i;
    var keep = sentences.filter(function (sen, i) {
      if (i === 0) return true;
      var names = (competitors || []).filter(function (c) { return c && sen.toLowerCase().indexOf(String(c).toLowerCase()) >= 0; });
      return !(names.length && claim.test(sen));
    });
    var out = keep.join('').replace(/\u0000/g, '.').replace(/\s+/g, ' ').trim();
    return out + (tagM ? ' ' + tagM[0].trim() : '');
  };

  // Synthetic persona names mean nothing to the customer. Use the role.
  G.replacePersonaNames = function (text, personas) {
    var out = String(text || '');
    (personas || []).forEach(function (p) {
      if (!p || !p.name || p.name.length < 4) return;
      var role = String(p.title || 'buyer').trim();
      var art = /^[aeiou]/i.test(role) && !/^(uni|use)/i.test(role) ? 'an ' : 'a ';
      var nm = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(nm + '\\s*\\([^)]*\\)', 'g'), art + role)
               .replace(new RegExp(nm + "'s", 'g'), art + role + "'s")
               .replace(new RegExp(nm, 'g'), art + role);
    });
    return out;
  };

  // One lever, once. Keys: comparison page per competitor, a page path, an
  // outside site to pitch or list on, a new page per question, a schema type,
  // re-running the audit. Also catches near-identical wording.
  function leverKeys(text, ctx) {
    var t = String(text || ''), lower = t.toLowerCase(), keys = [];
    var isCompare = /\b(vs\.?|versus|comparison|compare)\b/i.test(t);
    (ctx.competitors || []).forEach(function (c) { if (isCompare && c && lower.indexOf(String(c).toLowerCase()) >= 0) keys.push('comp:' + String(c).toLowerCase()); });
    (t.match(/(?:^|\s|\(|')(\/[a-z0-9][a-z0-9\-\/]{3,})/gi) || []).forEach(function (p) { keys.push('path:' + p.replace(/^[\s(']+/, '').replace(/\/+$/, '').toLowerCase()); });
    var own = String(ctx.siteDomain || '').toLowerCase();
    (lower.match(/\b[a-z0-9-]+\.(?:org|com|net|io|co|edu|gov|ai)\b/g) || []).forEach(function (d) { if (!own || d.indexOf(own) < 0) keys.push('site:' + d); });
    var newPage = CREATE.test(t) && /\b(page|article|guide|post|resource)\b/i.test(t);
    if (newPage) (t.match(/["\u201c']([^"\u201d']{12,120})["\u201d']/g) || []).forEach(function (q) { keys.push('q:' + q.slice(1, -1).toLowerCase()); });
    // A new page aimed at a gap question already covered by another new page
    // is a repeat, however it's worded (three healthcare pages for one query).
    if (newPage && !isCompare) (ctx.gapQueries || []).forEach(function (gq) {
      var gt = toks(gq); if (gt.length < 2) return;
      var it = toks(t); var hit = gt.filter(function (w) { return it.indexOf(w) >= 0; }).length;
      if (hit / gt.length >= 0.75) keys.push('gap:' + gq.toLowerCase());
    });
    if (!isCompare && !/\b(page|article|guide|post)\b/i.test(t.split(/[.!?]/)[0])) SCHEMA.forEach(function (s) { if (s.re.test(t)) keys.push('schema:' + s.type); });
    if (/re-?run(ning)? the (citro )?audit/i.test(t)) keys.push('rerun');
    return keys;
  }
  function words(t) { return String(t || '').toLowerCase().replace(/\(effort:[^)]*\)/, '').match(/[a-z0-9]{4,}/g) || []; }
  function jaccard(a, b) {
    var A = {}, B = {}, inter = 0, uni = 0, k;
    a.forEach(function (w) { A[w] = 1; }); b.forEach(function (w) { B[w] = 1; });
    for (k in A) { uni++; if (B[k]) inter++; }
    for (k in B) if (!A[k]) uni++;
    return uni ? inter / uni : 0;
  }
  // seen: { keys: {}, texts: [] } shared across phases.
  G.dedupe = function (items, seen, ctx) {
    seen = seen || { keys: {}, texts: [] };
    var kept = [], dropped = [];
    (items || []).forEach(function (it) {
      var t = typeof it === 'string' ? it : (it && it.action) || '';
      var ks = leverKeys(t, ctx || {});
      var dupKey = ks.find(function (k) { return seen.keys[k]; });
      var w = words(t);
      // Wording similarity only decides for items with no distinct lever
      // (two comparison pages for different competitors read alike but aren't repeats).
      var near = !ks.length && seen.texts.some(function (x) { return jaccard(x, w) >= 0.5; });
      if (dupKey || near) { dropped.push({ text: t, reason: 'Repeats an earlier item' + (dupKey ? ' (' + dupKey + ')' : '') }); return; }
      ks.forEach(function (k) { seen.keys[k] = 1; });
      seen.texts.push(w);
      kept.push(it);
    });
    return { kept: kept, dropped: dropped, seen: seen };
  };

  // Filter a list of generated recommendations. Returns { kept, dropped }.
  G.groundItems = function (items, f, ctx) {
    var kept = [], dropped = [];
    (items || []).forEach(function (it) {
      var text = typeof it === 'string' ? it : (it && (it.action || it.text)) || '';
      var bare = String(text).replace(/\s*(\(Effort:[^)]*\)|\[[^\]]*\])\s*$/i, '').trim();
      var why = !/[.!?)"'\u201d]$/.test(bare) ? 'Item was cut off' : problem(text, f || {}, ctx || {});
      if (why) dropped.push({ text: text, reason: why }); else kept.push(it);
    });
    return { kept: kept, dropped: dropped };
  };

  // Plain-text block for prompts: facts first, then rules.
  G.factsForPrompt = function (f, ctx) {
    ctx = ctx || {};
    if (!f || !f.reachable) {
      return 'SITE CHECK: the website could not be reached when this report ran. Do not make any recommendation about llms.txt, robots.txt, sitemaps, schema markup or existing pages, because none of it could be verified.';
    }
    var L = [];
    var date = (f.checkedAt || '').slice(0, 10);
    L.push('SITE CHECK (fetched live from ' + f.origin + (date ? ' on ' + date : '') + '; these are verified facts, not guesses):');
    var llm = function (x, name) {
      var s = st(x);
      return s === 'present' ? name + ': PRESENT (' + x.lines + ' lines, ' + x.links + ' links)' : s === 'missing' ? name + ': not found' : name + ': could not be checked';
    };
    L.push('- ' + llm(f.llms, 'llms.txt'));
    L.push('- ' + llm(f.llmsFull, 'llms-full.txt'));
    var rs = st(f.robots);
    if (rs === 'unknown') L.push('- robots.txt: could not be checked');
    else {
      var bl = blockedBots(f);
      L.push('- robots.txt: ' + (rs === 'missing' ? 'none (so every crawler is allowed)' : 'present') + '; AI crawlers ' + (bl.length ? 'BLOCKED: ' + bl.join(', ') : 'all allowed (' + BOT_LABELS.join(', ') + ')'));
    }
    if (f.homepage) L.push('- Homepage: ' + (f.homepage.noindex ? 'has a NOINDEX tag (search engines are told not to index it)' : 'indexable'));
    var sm = st(f.sitemap);
    L.push('- XML sitemap: ' + (sm === 'present' ? 'PRESENT, ' + n(f.sitemap.urlCount) + ' pages listed' : sm === 'missing' ? 'not found' : 'could not be checked'));
    var sch = f.schema || {};
    if (sch.status === 'checked') {
      L.push('- Schema.org types found on the ' + sch.pagesChecked + ' pages checked (' + (sch.sampledKinds || []).join(', ') + '): ' + ((sch.types || []).join(', ') || 'none'));
      (sch.byPage || []).filter(function (p) { return !p.error; }).forEach(function (p) { L.push('  - ' + p.kind + ' ' + pathOf(p.url) + ': ' + ((p.types || []).join(', ') || 'none')); });
      L.push('  Only say a type is missing from the kind of page it was checked on. Page kinds not listed here were not checked.');
    } else L.push('- Schema markup: could not be checked');
    if (hasInventory(f)) {
      var show = function (kind, label) {
        var p = pagesOf(f, kind).map(pathOf);
        return '- ' + label + ': ' + (countOf(f, kind) ? countOf(f, kind) + ' found, e.g. ' + p.slice(0, 6).join(', ') : 'none found');
      };
      L.push('- Existing pages (from ' + f.pages.source + ', ' + n(f.pages.inventoryCount) + ' pages):');
      L.push('  ' + show('comparison', 'Comparison / "vs" / alternatives pages').slice(2));
      L.push('  ' + show('faq', 'FAQ or help pages').slice(2) + ((f.helpSites || []).length ? '; help center linked from the homepage: ' + f.helpSites.join(', ') : ''));
      L.push('  ' + show('pricing', 'Pricing pages').slice(2));
      L.push('  ' + show('caseStudies', 'Case studies / customer stories').slice(2));
      L.push('  - Blog or resource articles: ' + countOf(f, 'blog'));
      if (hasPaths(f) && (ctx.gapQueries || []).length) {
        var cover = [];
        (ctx.gapQueries || []).forEach(function (q) { var p = bestPage(q, f); if (p) cover.push('"' + q + '" -> ' + p); });
        L.push('- Existing pages that already target gap questions (recommend improving these by path, not writing new pages): ' + (cover.length ? cover.slice(0, 8).join('; ') : 'none found'));
      }
    } else L.push('- Existing pages: could not be listed');
    var w = st(f.wikidata);
    L.push('- Wikidata: ' + (w === 'present' ? 'entry ' + f.wikidata.id + ' linked to this site' : w === 'missing' ? 'no entry linked to this site' : 'could not be checked'));
    L.push('');
    L.push('RULES FOR USING THE SITE CHECK (mandatory):');
    L.push('- Never recommend creating, adding or deploying anything the site check shows as PRESENT or found. You may recommend a specific improvement to it, and you must say it already exists.');
    L.push('- Never say something is missing unless the site check says it is missing or not found.');
    L.push('- If the site check says "could not be checked", make no recommendation about that item.');
    L.push('- Before recommending a new page, check the existing pages above; if a similar page exists, recommend improving that page by its path instead.');
    L.push('- Only recommend Google Business Profile if the business serves local customers' + (ctx.local ? ' (it does).' : ' (it does not, so do not mention it).'));
    L.push('- Only name review sites, directories or publications that appear in the list of sources the AI platforms read.');
    return L.join('\n');
  };

  // The "Technical foundation" paragraph, written only from facts.
  G.technicalText = function (f, ctx) {
    ctx = ctx || {};
    if (!f || !f.reachable) {
      return 'We could not reach ' + ((f && f.site) || 'your website') + ' when this report ran, so it makes no site-level technical recommendations. Re-run the audit, or check that the site loads for automated visitors.';
    }
    var out = [];
    if (f.homepage && f.homepage.noindex) out.push('Your homepage carries a noindex tag, which tells search engines not to index it. AI assistants that search the web rely on those indexes, so removing it is the first fix.');
    var bl = blockedBots(f);
    if (st(f.robots) !== 'unknown') {
      out.push(bl.length
        ? 'Your robots.txt blocks ' + listJoin(bl) + '. Those crawlers feed the AI assistants your buyers use, so allowing them is a direct, low-effort fix.'
        : 'Your robots.txt lets the main AI crawlers in (' + BOT_LABELS.join(', ') + '), so access is not what is holding you back.');
    }
    var l = st(f.llms), lf = st(f.llmsFull);
    if (l === 'present') out.push('Your llms.txt is live (' + f.llms.lines + ' lines, ' + f.llms.links + ' links)' + (lf === 'present' ? ', and so is llms-full.txt' : '') + '. There is nothing to add here; keep ' + (lf === 'present' ? 'them' : 'it') + ' current as pages change.');
    else if (l === 'missing') out.push('There is no llms.txt at ' + f.origin + '/llms.txt. It is a short markdown file listing your key pages with one-line descriptions, a cheap way to give AI tools a clean map of the site, though no major assistant has confirmed it changes rankings.');
    var sch = f.schema || {};
    if (sch.status === 'checked') {
      var found = sch.types || [];
      var orgLike = ['Organization', 'Corporation', 'EducationalOrganization', 'LocalBusiness', 'ProfessionalService', 'OnlineBusiness'].some(function (x) { return found.indexOf(x) >= 0; });
      out.push('On the ' + sch.pagesChecked + ' pages we checked, the structured data we found was ' + (found.length ? listJoin(found.slice(0, 10)) : 'none') + '.' + (orgLike ? '' : ' None of them declares your organization (name, logo, website and social profiles in Organization markup), which is how AI systems tie the brand to its site; that is the markup worth adding first.'));
    }
    var sm = st(f.sitemap);
    if (sm === 'present') out.push('Your XML sitemap lists ' + n(f.sitemap.urlCount) + ' pages.');
    else if (sm === 'missing') out.push('We found no XML sitemap at the usual locations or in robots.txt. Publishing one helps search engines, and the AI assistants that rely on them, find every page.');
    var w = st(f.wikidata);
    if (w === 'present') out.push('Wikidata has an entry for you (' + f.wikidata.id + ') linked to your site.');
    else if (w === 'missing') out.push('There is no Wikidata entry linked to your site. Wikidata requires independent published sources, so treat it as a later step once you have press coverage.');
    if (ctx.local) out.push('Because your buyers search locally, confirm your Google Business Profile is claimed and complete; that is the one item here we cannot check from outside.');
    return out.join(' ');
  };

  // Rows for the "What we checked on your site" box.
  G.checkedRows = function (f, ctx) {
    ctx = ctx || {};
    if (!f) return [];
    if (!f.reachable) return [{ label: 'Website', status: 'unknown', detail: 'Could not be reached when this report ran' }];
    var rows = [];
    var llm = function (x, name, url) {
      var s = st(x);
      rows.push({ label: name, status: s === 'present' ? 'ok' : s === 'missing' ? 'missing' : 'unknown',
        detail: s === 'present' ? 'Found: ' + x.lines + ' lines, ' + x.links + ' links' : s === 'missing' ? 'Not found at ' + url : 'Could not be checked' + (x && x.httpStatus ? ' (HTTP ' + x.httpStatus + ')' : '') });
    };
    llm(f.llms, 'llms.txt', f.origin + '/llms.txt');
    llm(f.llmsFull, 'llms-full.txt', f.origin + '/llms-full.txt');
    var rs = st(f.robots), bl = blockedBots(f);
    rows.push({ label: 'AI crawler access (robots.txt)', status: rs === 'unknown' ? 'unknown' : bl.length ? 'missing' : 'ok',
      detail: rs === 'unknown' ? 'Could not be checked' : bl.length ? 'Blocks ' + bl.join(', ') : 'All main AI crawlers allowed' });
    if (f.homepage) rows.push({ label: 'Homepage indexable', status: f.homepage.noindex ? 'missing' : 'ok', detail: f.homepage.noindex ? 'Has a noindex tag' : 'Yes' });
    var sm = st(f.sitemap);
    rows.push({ label: 'XML sitemap', status: sm === 'present' ? 'ok' : sm === 'missing' ? 'missing' : 'unknown',
      detail: sm === 'present' ? n(f.sitemap.urlCount) + ' pages listed' : sm === 'missing' ? 'Not found' : 'Could not be checked' });
    var sch = f.schema || {};
    rows.push({ label: 'Structured data (schema.org)', status: sch.status !== 'checked' ? 'unknown' : (sch.types || []).length ? 'ok' : 'missing',
      detail: sch.status !== 'checked' ? 'Could not be checked' : ((sch.types || []).length ? (sch.types || []).slice(0, 8).join(', ') : 'None found') + ' (' + sch.pagesChecked + ' pages checked)' });
    if (hasInventory(f)) {
      rows.push({ label: 'Comparison pages', status: countOf(f, 'comparison') ? 'ok' : 'missing', detail: countOf(f, 'comparison') ? countOf(f, 'comparison') + ' found' : 'None found' });
      var helpN = countOf(f, 'faq'), hs = f.helpSites || [];
      rows.push({ label: 'FAQ or help pages', status: helpN || hs.length ? 'ok' : 'missing', detail: hs.length ? 'Help center at ' + hs[0].replace(/^https?:\/\//, '') + (helpN ? ', plus ' + helpN + ' on the main site' : '') : helpN ? helpN + ' found' : 'None found on the main site' });
      rows.push({ label: 'Case studies', status: countOf(f, 'caseStudies') ? 'ok' : 'missing', detail: countOf(f, 'caseStudies') ? countOf(f, 'caseStudies') + ' found' : 'None found' });
    }
    var w = st(f.wikidata);
    rows.push({ label: 'Wikidata entry', status: w === 'present' ? 'ok' : w === 'missing' ? 'missing' : 'unknown', detail: w === 'present' ? f.wikidata.id : w === 'missing' ? 'None linked to your site' : 'Could not be checked' });
    if (ctx.local) rows.push({ label: 'Google Business Profile', status: 'unknown', detail: 'Cannot be checked from outside; confirm it is claimed' });
    return rows;
  };

  G.checkedHtml = function (f, ctx) {
    var rows = G.checkedRows(f, ctx);
    if (!rows.length) return '';
    var icon = { ok: '✓', missing: '✕', unknown: '?' };
    var date = f && f.checkedAt ? new Date(f.checkedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    return '<p class="sources-note">We checked ' + esc((f && f.origin) || 'your site') + (date ? ' on ' + esc(date) : '') + ' before writing this plan. The plan does not recommend anything listed here as already in place.</p>' +
      '<div class="sc-table">' + rows.map(function (r) {
        return '<div class="sc-row sc-' + r.status + '"><span class="sc-ic">' + icon[r.status] + '</span><span class="sc-l">' + esc(r.label) + '</span><span class="sc-d">' + esc(r.detail) + '</span></div>';
      }).join('') + '</div>';
  };

  // Facts as saved with a run: drop the full page list.
  G.forSave = function (f) {
    if (!f) return f;
    var c = JSON.parse(JSON.stringify(f));
    delete c.paths;
    return c;
  };

  root.CitroGrounding = G;
  if (typeof module !== 'undefined' && module.exports) module.exports = G;
})(typeof window !== 'undefined' ? window : globalThis);
