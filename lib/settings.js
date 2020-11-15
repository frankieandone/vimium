// A "setting" is a stored key/value pair.  An "option" is a setting which has a default value and whose value
// can be changed on the options page.
//
// Option values which have never been changed by the user are in Settings.defaults.
//
// Settings whose values have been changed are:
// 1. stored either in chrome.storage.sync or in chrome.storage.local (but never both), and
// 2. cached in Settings.cache; on extension pages, Settings.cache uses localStorage (so it persists).
//
// In all cases except Settings.defaults, values are stored as jsonified strings.

// If the current frame is the Vomnibar or the HUD, then we'll need our Chrome stubs for the tests.
// We use "try" because this fails within iframes on Firefox (where failure doesn't actually matter).
try { if (window.chrome == null) { window.chrome = window.top != null ? window.top.chrome : undefined; } } catch (error) {}

let storageArea = (chrome.storage.sync != null) ? "sync" : "local";

const Settings = {
  debug: false,
  storage: chrome.storage[storageArea],
  cache: {},
  isLoaded: false,
  onLoadedCallbacks: [],

  init() {
    if (Utils.isExtensionPage() && Utils.isExtensionPage(window.top)) {
      // On extension pages, we use localStorage (or a copy of it) as the cache.
      // For UIComponents (or other content of ours in an iframe within a regular page), we can't access
      // localStorage, so we check that the top level frame is also an extension page.
      this.cache = Utils.isBackgroundPage() ?
        localStorage :
        Object.assign({}, localStorage);
      this.runOnLoadedCallbacks();
    }

    // Test chrome.storage.sync to see if it is enabled.
    // NOTE(mrmr1993, 2017-04-18): currently the API is defined in FF, but it is disabled behind a flag in
    // about:config. Every use sets chrome.runtime.lastError, so we use that to check whether we can use it.
    chrome.storage.sync.get(null, () => {
      if (chrome.runtime.lastError) {
        storageArea = "local";
        this.storage = chrome.storage[storageArea];
      }

      // Delay this initialisation until after the correct storage area is known.  The significance of this is
      // that it delays the on-loaded callbacks.
      chrome.storage.local.get(null, localItems => {
        if (chrome.runtime.lastError) { localItems = {}; }
        return this.storage.get(null, syncedItems => {
          if (!chrome.runtime.lastError) {
            // TODO(philc): I think localItems can only be null in tests.
            const object = Object.assign(localItems || {}, syncedItems);
            for (let key of Object.keys(object)) {
              const value = object[key];
              this.handleUpdateFromChromeStorage(key, value);
            }
          }

          chrome.storage.onChanged.addListener((changes, area) => {
            if (area === storageArea) { return this.propagateChangesFromChromeStorage(changes); }
          });

          this.runOnLoadedCallbacks();
        });
      });
    });
  },

  // Called after @cache has been initialized.  On extension pages, this will be called twice, but that does
  // not matter because it's idempotent.
  runOnLoadedCallbacks() {
    this.log(`runOnLoadedCallbacks: ${this.onLoadedCallbacks.length} callback(s)`);
    this.isLoaded = true;
    while (0 < this.onLoadedCallbacks.length) { this.onLoadedCallbacks.pop()(); }
  },

  // Returns the value of callback if it can be executed immediately.
  // TODO(philc): This return value behavior is strange. Ideally this returns nil, as you would expect from a
  // potentially async function.
  onLoaded(callback) {
    if (this.isLoaded) {
      return callback();
    } else {
      this.onLoadedCallbacks.push(callback);
    }
  },

  shouldSyncKey(key) {
    return (key in this.defaults) && !["settingsVersion", "previousVersion"].includes(key);
  },

  propagateChangesFromChromeStorage(changes) {
    for (let key of Object.keys(changes || {})) {
      const change = changes[key];
      this.handleUpdateFromChromeStorage(key, change != null ? change.newValue : undefined);
    }
  },

  handleUpdateFromChromeStorage(key, value) {
    this.log(`handleUpdateFromChromeStorage: ${key}`);
    // Note: value here is either null or a JSONified string. Therefore, even falsy settings values (like
    // false, 0 or "") are truthy here.  Only null is falsy.
    if (this.shouldSyncKey(key)) {
      if (!value || !(key in this.cache) || (this.cache[key] !== value)) {
        if (value == null) { value = JSON.stringify(this.defaults[key]); }
        this.set(key, JSON.parse(value), false);
      }
    }
  },

  get(key) {
    if (!this.isLoaded)
      console.log(`WARNING: Settings have not loaded yet; using the default value for ${key}.`);
    if (key in this.cache && (this.cache[key] != null))
      return JSON.parse(this.cache[key]);
    else
      return this.defaults[key];
  },

  set(key, value, shouldSetInSyncedStorage) {
    if (shouldSetInSyncedStorage == null) { shouldSetInSyncedStorage = true; }
    this.cache[key] = JSON.stringify(value);
    this.log(`set: ${key} (length=${this.cache[key].length}, shouldSetInSyncedStorage=${shouldSetInSyncedStorage})`);
    if (this.shouldSyncKey(key)) {
      if (shouldSetInSyncedStorage) {
        const setting = {}; setting[key] = this.cache[key];
        this.log(`   chrome.storage.${storageArea}.set(${key})`);
        this.storage.set(setting);
      }
      if (Utils.isBackgroundPage() && (storageArea === "sync")) {
        // Remove options installed by the "copyNonDefaultsToChromeStorage-20150717" migration; see below.
        this.log(`   chrome.storage.local.remove(${key})`);
        chrome.storage.local.remove(key);
      }
    }
    // NOTE(mrmr1993): In FF, |value| will be garbage collected when the page owning it is unloaded.
    // Any postUpdateHooks that can be called from the options page/exclusions popup should be careful not to
    // use |value| asynchronously, or else it may refer to a |DeadObject| and accesses will throw an error.
    this.performPostUpdateHook(key, value);
  },

  clear(key) {
    this.log(`clear: ${key}`);
    this.set(key, this.defaults[key]);
  },

  has(key) { return key in this.cache; },

  use(key, callback) {
    this.log(`use: ${key} (isLoaded=${this.isLoaded})`);
    this.onLoaded(() => callback(this.get(key)));
  },

  // For settings which require action when their value changes, add hooks to this object.
  postUpdateHooks: {},
  performPostUpdateHook(key, value) {
    if (this.postUpdateHooks[key])
      this.postUpdateHooks[key](value);
  },

  // Completely remove a settings value, e.g. after migration to a new setting.  This should probably only be
  // called from the background page.
  nuke(key) {
    delete localStorage[key];
    chrome.storage.local.remove(key);
    if (chrome.storage.sync != null) {
      chrome.storage.sync.remove(key);
    }
  },

  // For development only.
  log(...args) {
    if (this.debug) { console.log("settings:", ...args); }
  },

  // Default values for all settings.
  defaults: {
    scrollStepSize: 60,
    smoothScroll: true,
    keyMappings: "# Insert your preferred key mappings here.",
    linkHintCharacters: "sadfjklewcmpgh",
    linkHintNumbers: "0123456789",
    filterLinkHints: false,
    hideHud: false,
    userDefinedLinkHintCss: ":root{--font-size:10;--font-weight:400;--search-box-font:Fira Code,sans-serif;--marker-font:-apple-system,BlinkMacSystemFont,sans-serif;--font:-apple-system,BlinkMacSystemFont,sans-serif;--search-box-font-size:xxx-large;--search-box-suggestion-items-font-size:x-large;--padding:0;--radius:25px;--shadow:0 2px 4px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.24);--fg:#C5C8C6;--bg:#282A2E;--border:#ff373B41;--main-fg:#81A2BE;--accent-fg:#52C196}#vimiumHintMarkerContainer div.internalVimiumHintMarker,#vimiumHintMarkerContainer div.vimiumHintMarker{background:transparent;backdrop-filter:blur(2px);border-radius:var(--radius);font-family:var(--marker-font);box-shadow:none;text-shadow:none;border:none;padding:2px 2px}#vimiumHintMarkerContainer div span{color:var(--accent-fg);font-family:var(--marker-font);font-size:var(--font-size);font-weight:400;text-shadow:none}#vimiumHintMarkerContainer div>.matchingCharacter{opacity:.3}#vimiumHintMarkerContainer div>.matchingCharacter~span{color:var(--main-fg)}#vomnibar{animation:show 200ms cubic-bezier(0,0,.2,1) forwards;background:transparent;border:none;box-shadow:none;border-radius:var(--radius);backdrop-filter:blur(2px)}@keyframes show{0%{opacity:0;transform:translateY(50px)}100%{opacity:1;transform:translateY(0)}}#vomnibar .vomnibarSearchArea,#vomnibar input{background:transparent;border:none;box-shadow:none;color:var(--fg)}#vomnibar .vomnibarSearchArea{padding:10px}#vomnibar input{font-family:var(--search-box-font);font-size:var(--search-box-font-size);font-weight:500;padding:50px 10px}#vomnibar ul{border-top:1px solid var(--border);padding:5px 0 25px 0;margin:0;background:transparent}#vomnibar li{border-bottom:transparent;font-size:var(--search-box-suggestion-items-font-size)}#vomnibar li .vomnibarSource{color:var(--main-fg);font-family:var(--font);font-size:var(--font-size);font-weight:var(--font-weight)}#vomnibar li em,#vomnibar li .vomnibarTitle{color:var(--main-fg);font-family:var(--font);font-size:var(--font-size);font-weight:var(--font-weight)}#vomnibar li .vomnibarUrl{color:var(--fg);font-family:var(--font);font-size:var(--font-size);font-weight:var(--font-weight)}#vomnibar li .vomnibarMatch{color:var(--accent-fg);font-weight:400}#vomnibar li .vomnibarTitle .vomnibarMatch{color:var(--main-fg)}#vomnibar li.vomnibarSelected{background-color:var(--border)}div.vimiumHUD{background:var(--border);box-shadow:none;position:absolute;top:0;right:0;padding:10px;margin:24px 0;border-radius:var(--radius);backdrop-filter:blue(2px)}div.vimiumHUD span#hud-find-input,div.vimiumHUD .vimiumHUDSearchAreaInner{color:var(--fg);font-family:var(--font);font-size:var(--font-size);font-weight:var(--font-weight);padding:0;margin:0;left:0;right:0}div.vimiumHUD .hud-find{background-color:transparent;border:none;padding:0;margin:0;left:0;right:0}div.vimiumHUD .vimiumHUDSearchArea{background-color:transparent;padding:0;margin:0;left:0;right:0}"
    ,
    // Default exclusion rules.
    exclusionRules:
      [
        // Disable Vimium on Gmail.
        { pattern: "https?://mail.google.com/*", passKeys: "" }
      ],

    // NOTE: If a page contains both a single angle-bracket link and a double angle-bracket link, then in
    // most cases the single bracket link will be "prev/next page" and the double bracket link will be
    // "first/last page", so we put the single bracket first in the pattern string so that it gets searched
    // for first.

    // "\bprev\b,\bprevious\b,\bback\b,<,‹,←,«,≪,<<"
    previousPatterns: "prev,previous,back,older,<,\u2039,\u2190,\xab,\u226a,<<",
    // "\bnext\b,\bmore\b,>,›,→,»,≫,>>"
    nextPatterns: "next,more,newer,>,\u203a,\u2192,\xbb,\u226b,>>",
    // default/fall back search engine
    searchUrl: "https://www.google.com/search?q=",
    // put in an example search engine
    searchEngines:
"w:https://www.wikipedia.org/w/index.php?title=Special:Search&search=%s Wikipedia g:https://www.google.com/search?q=%s Google y:https://www.youtube.com/results?search_query=%s Youtube gm:https://www.google.com/maps?q=%s Google maps d:https://duckduckgo.com/?q=%s DuckDuckGo az:https://www.amazon.com/s/?field-keywords=%s Amazon",
    newTabUrl: "about:newtab",
    grabBackFocus: false,
    regexFindMode: false,
    waitForEnterForFilteredHints: false, // Note: this defaults to true for new users; see below.

    settingsVersion: "",
    helpDialog_showAdvancedCommands: false,
    optionsPage_showAdvancedOptions: false,
    passNextKeyKeys: [],
    ignoreKeyboardLayout: false
  }
};

Settings.init();

// Perform migration from old settings versions, if this is the background page.
if (Utils.isBackgroundPage()) {
  Settings.applyMigrations = function() {
    if (!Settings.get("settingsVersion")) {
      // This is a new install. For some settings, we retain a legacy default behaviour for existing users but
      // use a non-default behaviour for new users.

      // For waitForEnterForFilteredHints, "true" gives a better UX; see #1950. However, forcing the change on
      // existing users would be unnecessarily disruptive. So, only new users default to "true".
      Settings.set("waitForEnterForFilteredHints", true);
    }

    // We use settingsVersion to coordinate any necessary schema changes.
    Settings.set("settingsVersion", Utils.getCurrentVersion());

    // Remove legacy key which was used to control storage migration. This was after 1.57 (2016-10-01), and
    // can be removed after 1.58 has been out for sufficiently long.
    Settings.nuke("copyNonDefaultsToChromeStorage-20150717");
  };

  Settings.onLoaded(Settings.applyMigrations.bind(Settings));
}

global.Settings = Settings;
