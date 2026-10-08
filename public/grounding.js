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
  // A type counts when "schema", "markup" or "structured data" follows in the
  // same clause, so "Organization and Course schema" names both.
  function sre(names) { return new RegExp('\\b(' + names + ')\\b(?=[^.;:]{0,50}\\b(schema|markup|structured data)\\b)', 'i'); }
  var SCHEMA = [
    { type: 'FAQPage',             re: /\bFAQ ?Page\b|\bFAQ (schema|markup|structured data)\b/i, also: [] },
    { type: 'Organization',        re: sre('Organi[sz]ation|EducationalOrganization|Corporation'), also: ['Corporation', 'EducationalOrganization', 'LocalBusiness', 'NGO', 'OnlineBusiness', 'ProfessionalService', 'NewsMediaOrganization'] },
    { type: 'Product',             re: sre('Product'), also: ['ProductGroup', 'IndividualProduct'], pageKind: 'offering' },
    // Course, CourseInstance and EducationalOccupationalProgram describe the
    // same thing (a training program) and are one lever.
    { type: 'Course',              re: /\b(CourseInstance|EducationalOccupationalProgram)\b/i, also: ['CourseInstance', 'EducationalOccupationalProgram'], pageKind: 'offering' },
    { type: 'Course',              re: sre('Course'), also: ['CourseInstance', 'EducationalOccupationalProgram'], pageKind: 'offering' },
    { type: 'SoftwareApplication', re: /\bSoftwareApplication\b/i, also: ['WebApplication', 'MobileApplication'], pageKind: 'offering' },
    { type: 'Service',             re: sre('Service'), also: ['ProfessionalService'], pageKind: 'offering' },
    { type: 'ProfessionalService', re: /\bProfessionalService\b/i, also: [] },
    { type: 'LocalBusiness',       re: /\bLocalBusiness\b/i, also: [] },
    { type: 'HowTo',               re: /\bHowTo\b/i, also: [], pageKind: 'blog' },
    { type: 'AggregateRating',     re: /\b(AggregateRating|Review (schema|markup))\b/i, also: ['Review'] },
    { type: 'Article',             re: sre('Article|BlogPosting'), also: ['BlogPosting', 'NewsArticle'], pageKind: 'blog' },
    { type: 'BreadcrumbList',      re: /\bBreadcrumb(List)?\b/i, also: [] },
    { type: 'Event',               re: sre('Event|EducationEvent'), also: ['EducationEvent', 'BusinessEvent'], pageKind: 'offering' },
    { type: 'Person',              re: sre('Person'), also: [] },
    { type: 'WebSite',             re: sre('WebSite'), also: [] },
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

    // A new page whose topic an existing program page already covers, e.g. a new
    // /solutions/communication-training-for-healthcare/ when the site has
    // /solutions/crucial-conversations-for-dialogue/healthcare/.
    var np = newPathOf(t);
    if (np && hasPaths(f) && !/\b(vs\.?|versus|comparison|compare|alternatives?)\b/i.test(t)) {
      var topic = toks(np.replace(/[\/\-_.]+/g, ' ')).filter(function (w) { return !GENERICISH.test(w) && !/^(solution|resource|page|communication|vs|new|research|blog|article)$/.test(w); });
      // Words in many program URLs ("crucial", "conversations") name the brand
      // or product line, not a topic; only rarer words decide.
      var offering = f._offering || (f._offering = f.paths.filter(function (p) { return OFFERING_PAGE.test(p); }));
      topic = topic.filter(function (w) { return offering.filter(function (p) { return toks(p.replace(/[\/\-_.]+/g, ' ')).indexOf(w) >= 0; }).length < 3; });
      if (topic.length) {
        var cover = f.paths.find(function (p) {
          if (!OFFERING_PAGE.test(p) || normPath(p) === normPath(np)) return false;
          var pt = toks(p.replace(/[\/\-_.]+/g, ' '));
          return topic.every(function (w) { return pt.indexOf(w) >= 0; });
        });
        if (cover) return 'Site already has a page for this (' + cover + ')';
      }
    }

    // FAQ / help pages
    if (/\b(FAQ|frequently asked questions) (page|hub|center|centre|library)\b|\bhelp center\b/i.test(t) && creates(t)) {
      if ((f && f.helpSites || []).length) return 'Site already has a help center (' + f.helpSites[0] + ')';
      if (!hasInventory(f)) return 'Could not check existing pages for an FAQ page';
      if (countOf(f, 'faq') > 0) return 'Site already has FAQ or help pages (' + pathOf(pagesOf(f, 'faq')[0]) + ')';
    }

    if (np && /^\/(faq|faqs|help|support)(\/|$)/i.test(np) && ((f && f.helpSites || []).length || countOf(f, 'faq') > 0)) return 'Site already has a help center or FAQ pages';
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
    if (/\bwikidata\b/i.test(t)) return 'Wikidata needs independent coverage first; not a plan item';

    // Outreach to a competitor's own site (e.g. a guest post on radicalcandor.com).
    var doms = t.toLowerCase().match(/\b[a-z0-9-]+\.(?:org|com|net|io|co|edu|ai)\b/g) || [];
    for (var di = 0; di < doms.length; di++) {
      var root = doms[di].split('.')[0].replace(/-/g, '');
      var rival = (ctx.competitors || []).find(function (c) { var w = slugWords(c).join(''); return w.length >= 5 && (root === w || root.indexOf(w) === 0 || (w.indexOf(root) === 0 && root.length >= 6)); });
      if (rival && /\b(pitch|guest|contribut|partner|reach out|outreach|byline|co-?author|link from)/i.test(t)) return 'Recommends outreach to a competitor\u2019s site (' + doms[di] + ', ' + rival + ')';
    }
    // Press-release wires are paid distribution, not publications to pitch.
    if (/\b(prnewswire|pr newswire|businesswire|business wire|globenewswire)\b/i.test(t) && /\b(pitch|byline|contribut|guest)/i.test(t)) return 'Press-release wires are paid distribution, not a publication to pitch';
    // Outreach to a site only one answer used: too thin to be worth a plan item.
    var first0 = t.split(/(?<!\b(?:e\.g|i\.e|vs))[.!?](?:\s|$)/)[0];
    if (ctx.sourceCounts && OUTREACH.test(first0)) {
      var own0 = String(ctx.siteDomain || '').toLowerCase();
      var od = (first0.toLowerCase().match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:org|com|net|io|co|me|ai|edu|gov)\b/g) || []).filter(function (d) { return !own0 || d.indexOf(own0) < 0; });
      if (od.length && od.every(function (d) { return (ctx.sourceCounts[d] || 0) < 2; })) return 'Outreach to ' + od[0] + ', which only one answer used';
    }
    if (/\b(pitch|byline|bylined|contribut|guest)/i.test(t) && /\b[a-z0-9-]+\.(edu|gov)\b/i.test(t)) return 'Universities and government sites do not publish vendor-written articles';
    if (/\breddit\b/i.test(t) && /\b(byline|bylined|pitch)/i.test(t)) return 'Reddit takes participation, not pitched or bylined articles';

    // Google Business Profile: only for businesses with local buyers.
    if (/google business profile|google my business|\bGBP\b/i.test(t) && !ctx.local) return 'Google Business Profile only applies to businesses with local buyers';

    // Review sites and directories: only the ones AI actually read.
    for (var k = 0; k < DIRS.length; k++) {
      if (DIRS[k].re.test(t) && !sourcesInclude(ctx.sourceDomains, DIRS[k].domain)) return DIRS[k].domain + ' was not among the sources AI read for these questions';
    }

    if (/\bnot (named|listed|included|found|cited|among)\b[^.)]{0,30}\bsources\b|\bneither\b[^.]{0,80}\b(appeared|appear|is|was|were)\b[^.]{0,30}\bsources\b|\b(did not|didn't|does not|doesn't) appear\b[^.]{0,30}\bsources\b/i.test(t)) return 'Names a site the AI answers did not read';
    // A pitch has to name a publication the AI answers actually read.
    if (/\b(pitch|bylined?|contributed (article|piece)|guest (post|article))\b/i.test(t) && (ctx.sourceDomains || []).length) {
      var named = (t.toLowerCase().match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:org|com|net|io|co|me|ai|edu|gov)\b/g) || []).some(function (d) { return sourcesInclude(ctx.sourceDomains, d); }) ||
        DIRS.some(function (d) { return d.re.test(t) && sourcesInclude(ctx.sourceDomains, d.domain); });
      if (!named) return 'Pitch to a publication that is not among the sources AI read';
    }
    var fake = unknownPaths(t, f);
    if (fake.length) return 'Cites ' + fake[0] + ' as an existing page, but the site has no such page';

    if (!siteOk && /\b(your|the) (site|website|homepage|pages?)\b/i.test(t) && /\b(markup|schema|llms|robots|sitemap|crawl)/i.test(t)) return 'Site could not be reached to verify';
    return null;
  }

  G.problem = problem;

  // A domain that belongs to a named competitor (dalecarnegie.com, shop.ccl.org).
  G.isCompetitorDomain = function (domain, competitors) {
    var parts = String(domain || '').toLowerCase().split('.');
    return (competitors || []).some(function (c) {
      var w = slugWords(c).join(''); if (w.length < 3) return false;
      var initials = String(c).split(/\s+/).filter(function (x) { return /^[A-Z]/.test(x); }).map(function (x) { return x[0]; }).join('').toLowerCase();
      return parts.some(function (p) { p = p.replace(/-/g, ''); return p === w || (w.length >= 5 && (p.indexOf(w) === 0 || (w.indexOf(p) === 0 && p.length >= 6))) || (initials.length >= 3 && p === initials); });
    });
  };

  // Paths in an item that are cited as existing pages but are not on the site.
  // A path proposed for a new page ("a new page at /vs/x/") is fine.
  var PATH_RE = /(^|[\s(,'"\u201c\u2018])(\/[a-z0-9][a-z0-9\-\/._]*[a-z0-9\/])/gi;
  function normPath(p) { return String(p).toLowerCase().replace(/[.,;:]+$/, '').replace(/\/+$/, '') || '/'; }
  function pathSet(f) {
    if (!hasPaths(f)) return null;
    if (!f._pathSet) { var o = {}; f.paths.forEach(function (p) { o[normPath(p)] = 1; }); Object.defineProperty(f, '_pathSet', { value: o, enumerable: false }); }
    return f._pathSet;
  }
  function citedAsNew(text, idx) {
    var win = text.slice(Math.max(0, idx - 90), idx).replace(/\b(e\.g|i\.e)\./gi, 'eg');
    if (/\b(existing|current|live)\b[^.]{0,40}$/i.test(win)) return false;
    return /\bnew\b[^.]{0,60}$|\b(such as|path like|titled|slug|url like)\b[^.]{0,20}$/i.test(win) ||
      /\b(write|publish|create|build|launch|add|commission|stand up|put up)\b[^.]{0,80}\b(at|under)\s*$/i.test(win);
  }
  function unknownPaths(text, f) {
    var set = pathSet(f); if (!set) return [];
    var t = String(text || ''), out = [], m;
    PATH_RE.lastIndex = 0;
    while ((m = PATH_RE.exec(t))) {
      var p = m[2], idx = m.index + m[1].length;
      if (/\.(txt|xml|json|js|css|pdf|png|jpe?g|svg)$/i.test(p)) continue;
      if (p.split('/').filter(Boolean).length === 0) continue;
      if (set[normPath(p)] || citedAsNew(t, idx)) continue;
      out.push(p);
    }
    return out;
  }
  G.unknownPaths = unknownPaths;

  // Repair rather than drop: invented example paths inside "(e.g., ...)" are
  // removed from the example, and the parenthetical goes if nothing is left.
  G.fixPaths = function (text, f) {
    var t = String(text || '');
    if (!pathSet(f)) return t;
    return t.replace(/\s*\((e\.g\.,?|for example,?|such as|like)\s+([^()]*)\)/gi, function (all, lead, body) {
      var bad = unknownPaths(' ' + body, f);
      if (!bad.length) return all;
      var parts = body.split(/\s*(?:,|\band\b|\bor\b)\s*/).filter(function (x) { return x && bad.indexOf(x.trim().replace(/[.,;]+$/, '')) < 0; });
      var kept = parts.filter(function (x) { return /^\//.test(x.trim()); });
      return kept.length ? ' (' + lead + ' ' + kept.join(', ') + ')' : '';
    });
  };

  // Why the homepage couldn't be read, in plain words.
  function blockedReason(f) {
    var e = (f && f.homeError) || {};
    if ((e.status === 403 || e.status === 429 || e.status === 503) && e.protection) return 'its bot protection (' + e.protection + ') turned our automated check away (HTTP ' + e.status + ')';
    if (e.status === 403 || e.status === 429) return 'it turned our automated check away (HTTP ' + e.status + ')';
    if (e.status) return 'it returned an error (HTTP ' + e.status + ')';
    if (e.error === 'timeout') return 'it did not respond in time';
    return 'it could not be reached';
  }
  G.blockedReason = blockedReason;

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
    // Items are filtered and reordered after writing, so "item 10 above" points nowhere.
    var src = String(text || '')
      .replace(/\s*\((?:see |from |per )?items? \d+(?:\s*(?:and|,|-)\s*\d+)*(?: above| below)?\)/gi, '')
      .replace(/,?\s*\b(?:as in|from|see|per) items? \d+(?: above| below)?\b/gi, '')
      .replace(/\s+(?:recommended|covered|described) (?:separately|elsewhere(?: in (?:this|the) plan)?|above|below)\b/gi, '');
    src = src.replace(/\bcitation weight\b/gi, 'visibility');
    var tagM = src.match(/\s*\(Effort:[^)]*\)\s*$/);
    var body = tagM ? src.slice(0, tagM.index) : src;
    // Protect abbreviations and decimals so "e.g." or "3.5" don't end a sentence.
    var safe = body.replace(/\b(e\.g|i\.e|etc|vs|approx|incl|U\.S|No)\./gi, function (m) { return m.replace(/\./g, '\u0000'); })
                   .replace(/(\w)\.(\w)/g, '$1\u0000$2');
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

  // Summary, key finding and projection are prose, not plan items, so they
  // never went through the site check. A projection once said "by expanding
  // the existing llms.txt". Drop any sentence that touches the site-check
  // items; use the fallback if nothing is left.
  var SITE_CHECK_TERMS = /llms(-full)?\.txt|\bllms\b|robots\.txt|\bsitemap\b|\bwikidata\b|ai crawlers?/i;
  G.cleanNarrative = function (text, fallback) {
    var t = String(text || '').trim();
    if (!SITE_CHECK_TERMS.test(t)) return t;
    var safe = t.replace(/\b(e\.g|i\.e|etc|vs|approx|incl|U\.S|No)\./gi, function (m) { return m.replace(/\./g, '\u0000'); });
    var kept = (safe.match(/(?:[^.!?]|[.!?](?!\s|$))+[.!?]*(?:\s+|$)/g) || []).filter(function (x) { return !SITE_CHECK_TERMS.test(x); }).join('').replace(/\u0000/g, '.').trim();
    return kept || String(fallback || '');
  };

  // Sentences that call a platform a total miss when it scored above 0%
  // ("zero presence on Claude and Grok" with Claude at 25%). Per-question
  // claims ("zero visibility for this query") are fine.
  var ZERO_CLAIM = /\b(zero|no|complete(ly)?|entire(ly)?|total(ly)?|fully)\b[^.]{0,25}\b(presence|visibility|absent|absence|invisible|invisibility|missing)\b|\b(absent|invisible|missing) (from|on|in)\b/i;
  var PER_QUESTION = /\b(query|queries|question|questions|prompt|for ['"\u2018\u201c])/i;
  function sentencesOf(t) {
    var safe = String(t || '').replace(/\b(e\.g|i\.e|etc|vs|approx|incl|U\.S|No)\./gi, function (m) { return m.replace(/\./g, '\u0000'); }).replace(/(\w)\.(\w)/g, '$1\u0000$2');
    return (safe.match(/(?:[^.!?]|[.!?](?!\s|$))+[.!?]*(?:\s+|$)/g) || []).map(function (x) { return x.replace(/\u0000/g, '.'); });
  }
  G.platformClaimIssues = function (text, pct) {
    var out = [];
    sentencesOf(text).forEach(function (sen) {
      if (!ZERO_CLAIM.test(sen) || PER_QUESTION.test(sen)) return;
      Object.keys(pct || {}).forEach(function (p) {
        var name = p.replace(/^Google /, '');
        if (pct[p] > 0 && new RegExp('\\b' + name + '\\b', 'i').test(sen)) out.push({ platform: p, pct: pct[p], sentence: sen.trim() });
      });
    });
    return out;
  };
  G.dropPlatformClaims = function (text, pct) {
    var bad = G.platformClaimIssues(text, pct).map(function (x) { return x.sentence; });
    if (!bad.length) return text;
    return sentencesOf(text).filter(function (s) { return bad.indexOf(s.trim()) < 0; }).join('').trim();
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
  var MARKUP_ITEM = /^\s*(add|adding|implement|implementing|deploy|apply|mark up|layer|extend)\b[^.]{0,90}\b(schema|markup|structured data)\b/i;
  function leverKeys(text, ctx) {
    var t = String(text || ''), lower = t.toLowerCase(), keys = [];
    var isCompare = /\b(vs\.?|versus|comparison|compare)\b/i.test(t);
    (ctx.competitors || []).forEach(function (c) {
      var slug = slugWords(c).join('-');
      if (isCompare && c && (lower.indexOf(String(c).toLowerCase()) >= 0 || (slug.length >= 5 && lower.indexOf(slug) >= 0))) keys.push('comp:' + String(c).toLowerCase());
    });
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
    // An item whose first clause adds markup claims those schema types, wherever
    // it puts them (three HowTo items on three different pages are one lever).
    var first = t.split(/(?<!\b(?:e\.g|i\.e|vs))[.!?](?:\s|$)/)[0];
    if (!isCompare && MARKUP_ITEM.test(first)) SCHEMA.forEach(function (s) { if (s.re.test(first)) keys.push('schema:' + s.type); });
    // Reviews on one site, or taking part on Reddit, is one lever however often it is reworded.
    DIRS.forEach(function (d) { if (d.re.test(first)) keys.push('site:' + d.domain); });
    if (/\breddit\b|(^|\s)r\/[a-z]/i.test(first)) keys.push('site:reddit.com');
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
  var OUTREACH = /^\s*(brief|reach out|engage with|contact|email|submit|pitch|send|get|pursue|expand|secure|request|ensure|confirm)\b[^.]{0,200}\b[a-z0-9-]+\.(?:org|com|net|io|co|me|ai|edu|gov)\b/i;
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
      // Briefing individual third-party sites: two in a 90-day plan is plenty.
      if (OUTREACH.test(t.split(/(?<!\b(?:e\.g|i\.e|vs))[.!?](?:\s|$)/)[0])) {
        seen.outreach = (seen.outreach || 0) + 1;
        if (seen.outreach > 2) { dropped.push({ text: t, reason: 'More than two site outreach items' }); return; }
      }
      ks.forEach(function (k) { seen.keys[k] = 1; });
      seen.texts.push(w);
      kept.push(it);
    });
    return { kept: kept, dropped: dropped, seen: seen };
  };

  // The shortlist and the plan are written separately, so the same new page
  // could get two URLs (/vs/dale-carnegie/ and /solutions/...-vs-dale-carnegie/).
  // Give plan items the shortlist's path for the same lever.
  function newPathOf(t) {
    var m; PATH_RE.lastIndex = 0;
    while ((m = PATH_RE.exec(t))) { if (citedAsNew(t, m.index + m[1].length)) return m[2]; }
    return null;
  }
  // A comparison page shares its path only with the same comparison; a topic
  // page only with a page for the same question. (A Dale Carnegie comparison
  // that quoted the SaaS question once handed its URL to the SaaS page.)
  function alignKeys(t, ctx) {
    var cmp = /\b(vs\.?|versus|comparison|compare)\b/i.test(t);
    return leverKeys(t, ctx || {}).filter(function (k) { return cmp ? /^comp:/.test(k) : /^(gap|q):/.test(k); });
  }
  G.alignPaths = function (recTexts, planItems, ctx) {
    var byKey = {};
    (recTexts || []).forEach(function (r) {
      var p = newPathOf(String(r || '')); if (!p) return;
      alignKeys(String(r), ctx).forEach(function (k) { if (!byKey[k]) byKey[k] = p; });
    });
    return (planItems || []).map(function (it) {
      var t = String(it || ''), p = newPathOf(t); if (!p) return it;
      var k = alignKeys(t, ctx).find(function (x) { return byKey[x]; });
      return k && byKey[k] !== p ? t.split(p).join(byKey[k]) : it;
    });
  };

  // Items that build on "the new /path/ page" when no item in the plan creates
  // that page (a case-study item cross-linking to a SaaS page nobody proposed).
  var THE_NEW = /\bthe new (?:[a-z\-]+ )?(?:page (?:at )?)?(\/[a-z0-9][a-z0-9\-\/._]*)/gi;
  function referencedPaths(t) { var out = [], m; THE_NEW.lastIndex = 0; while ((m = THE_NEW.exec(String(t || '')))) out.push(normPath(m[1])); return out; }
  function createdPath(t) {
    var p = newPathOf(String(t || '')); if (!p) return null;
    // "a new /x/ page" creates it; "the new /x/ page" points back to another item.
    return referencedPaths(t).indexOf(normPath(p)) >= 0 ? null : normPath(p);
  }
  G.dropOrphanReferences = function (lists) {
    var created = {};
    lists.forEach(function (l) { (l || []).forEach(function (it) { var p = createdPath(typeof it === 'string' ? it : it && it.action); if (p) created[p] = 1; }); });
    var dropped = [];
    var kept = lists.map(function (l) {
      return (l || []).filter(function (it) {
        var t = typeof it === 'string' ? it : (it && it.action) || '';
        var orphan = referencedPaths(t).find(function (p) { return !created[p]; });
        if (orphan) { dropped.push({ text: t, reason: 'Builds on ' + orphan + ', which no item in the plan creates' }); return false; }
        return true;
      });
    });
    return { kept: kept, dropped: dropped };
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
    if (!f) {
      return 'SITE CHECK: the site check did not run. Do not make any recommendation about llms.txt, robots.txt, sitemaps, schema markup or existing pages, because none of it could be verified.';
    }
    var L = [];
    if (!f.reachable) L.push('NOTE: the homepage could not be read because ' + blockedReason(f) + '. Pages, schema markup and anything else marked "could not be checked" are unknown; make no recommendation about them.');
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
      L.push('  ' + show('offering', 'Program, product or service pages').slice(2));
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
    L.push('');
    L.push('RULES FOR USING THE SITE CHECK (mandatory):');
    L.push('- Never recommend creating, adding or deploying anything the site check shows as PRESENT or found. You may recommend a specific improvement to it, and you must say it already exists.');
    L.push('- Never say something is missing unless the site check says it is missing or not found.');
    L.push('- If the site check says "could not be checked", make no recommendation about that item.');
    L.push('- Before recommending a new page, check the existing pages above; if a similar page exists, recommend improving that page by its path instead.');
    L.push('- When you cite an existing page, use only a path listed above. Never guess a URL. Give a new page\'s path only when proposing that new page.');
    L.push('- Never refer to other items by number ("item 3 above"); items are reordered and filtered after writing.');
    L.push('- Only recommend Google Business Profile if the business serves local customers' + (ctx.local ? ' (it does).' : ' (it does not, so do not mention it).'));
    L.push('- Only name review sites, directories or publications that appear in the list of sources the AI platforms read.');
    return L.join('\n');
  };

  // The "Technical foundation" paragraph, written only from facts.
  G.technicalText = function (f, ctx) {
    ctx = ctx || {};
    if (!f) return 'The site check did not run for this report, so it makes no site-level technical recommendations. Re-run the audit to include it.';
    var out = [];
    if (!f.reachable) {
      var e = f.homeError || {};
      out.push('We could not read ' + (f.site || 'your homepage') + ' because ' + blockedReason(f) + ', so this report makes no recommendations about your pages or markup.');
      if (e.protection) out.push('Bot protection like ' + e.protection + ' can also block AI crawlers, separately from robots.txt. It is worth confirming those settings allow the AI crawlers you want, such as GPTBot, OAI-SearchBot, PerplexityBot and ClaudeBot.');
    }
    if (f.homepage && f.homepage.noindex) out.push('Your homepage carries a noindex tag, which tells search engines not to index it. AI assistants that search the web rely on those indexes, so removing it is the first fix.');
    var bl = blockedBots(f);
    if (st(f.robots) !== 'unknown') {
      out.push(bl.length
        ? 'Your robots.txt blocks ' + listJoin(bl) + '. Those crawlers feed the AI assistants your buyers use, so allowing them is a direct, low-effort fix.'
        : (!f.reachable && f.homeError && f.homeError.protection)
          ? 'Your robots.txt allows the main AI crawlers (' + BOT_LABELS.join(', ') + '), but that only matters if your bot protection lets them through.'
          : 'Your robots.txt lets the main AI crawlers in (' + BOT_LABELS.join(', ') + '), so access is not what is holding you back.');
    }
    var l = st(f.llms), lf = st(f.llmsFull);
    if (l === 'present') out.push('Your llms.txt is live (' + f.llms.lines + ' lines, ' + f.llms.links + ' links)' + (lf === 'present' ? ', and so is llms-full.txt' : '') + '. There is nothing to add here; keep ' + (lf === 'present' ? 'them' : 'it') + ' current as pages change.');
    else if (l === 'missing') out.push('There is no llms.txt at ' + f.origin + '/llms.txt. It is a short markdown file listing your key pages with one-line descriptions, a cheap way to give AI tools a clean map of the site, though no major assistant has confirmed it changes rankings.');
    var sch = f.schema || {};
    if (sch.status === 'checked') {
      var found = sch.types || [];
      var orgLike = ['Organization', 'Corporation', 'EducationalOrganization', 'LocalBusiness', 'ProfessionalService', 'OnlineBusiness'].some(function (x) { return found.indexOf(x) >= 0; });
      var shown = shownTypes(found);
      out.push('On the ' + sch.pagesChecked + ' pages we checked, the structured data we found was ' + (shown.length ? listJoin(shown) : 'none') + '.' + (orgLike ? '' : ' None of them declares your organization (name, logo, website and social profiles in Organization markup), which is how AI systems tie the brand to its site; that is the markup worth adding first.'));
    }
    var sm = st(f.sitemap);
    if (sm === 'present') out.push('Your XML sitemap lists ' + n(f.sitemap.urlCount) + ' pages.');
    else if (sm === 'missing') out.push('We found no XML sitemap at the usual locations or in robots.txt. Publishing one helps search engines, and the AI assistants that rely on them, find every page.');
    if (ctx.local) out.push('Because your buyers search locally, confirm your Google Business Profile is claimed and complete; that is the one item here we cannot check from outside.');
    return out.join(' ');
  };

  // Types worth naming to a customer. Search boxes and images inside the markup
  // (EntryPoint, SearchAction, ImageObject...) are parts of other types, not markup choices.
  var HELPER_TYPES = /^(EntryPoint|PropertyValueSpecification|ReadAction|SearchAction|CommentAction|ListItem|ImageObject|WPHeader|WPFooter|WPSideBar|SiteNavigationElement|ContactPoint|PostalAddress|GeoCoordinates|Offer|AggregateOffer|Rating|Answer|Question|Thing|ItemList|VideoObject|MonetaryAmount|QuantitativeValue|Language|Place|Country|DefinedTerm|InteractionCounter)$/;
  function shownTypes(types) { return (types || []).filter(function (x) { return !HELPER_TYPES.test(x); }).slice(0, 12); }

  // Rows for the "What we checked on your site" box.
  G.checkedRows = function (f, ctx) {
    ctx = ctx || {};
    if (!f) return [];
    var rows = [];
    if (!f.reachable) rows.push({ label: 'Homepage', status: 'unknown', detail: 'Not read: ' + blockedReason(f).replace(/^it /, '').replace(/^its /, '') });
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
      detail: sch.status !== 'checked' ? 'Could not be checked' : (shownTypes(sch.types).length ? shownTypes(sch.types).join(', ') : 'None found') + ' (' + sch.pagesChecked + ' pages checked)' });
    if (hasInventory(f)) {
      rows.push({ label: 'Comparison pages', status: countOf(f, 'comparison') ? 'ok' : 'missing', detail: countOf(f, 'comparison') ? countOf(f, 'comparison') + ' found' : 'None found' });
      var helpN = countOf(f, 'faq'), hs = f.helpSites || [];
      rows.push({ label: 'FAQ or help pages', status: helpN || hs.length ? 'ok' : 'missing', detail: hs.length ? 'Help center at ' + hs[0].replace(/^https?:\/\//, '') + (helpN ? ', plus ' + helpN + ' on the main site' : '') : helpN ? helpN + ' found' : 'None found on the main site' });
      rows.push({ label: 'Case studies', status: countOf(f, 'caseStudies') ? 'ok' : 'missing', detail: countOf(f, 'caseStudies') ? countOf(f, 'caseStudies') + ' found' : 'None found' });
    }
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
