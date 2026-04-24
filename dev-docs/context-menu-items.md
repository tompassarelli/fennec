# Context Menu Items

## Priority 1 — Ship now

### Palefox items
- [x] Rename Tab
- [x] Collapse / Expand (if has children)
- [x] Create Group
- [x] Close Children (if has children)

### Native actions
- [ ] Add Split View — `TabContextMenu.contextTab = tab; TabContextMenu.contextTabs = [tab]; TabContextMenu.moveTabsToSplitView()`
- [ ] Reload Tab — `gBrowser.reloadTab(tab)`
- [ ] Mute / Unmute Tab — `tab.toggleMuteAudio()` (label: check `tab.hasAttribute("muted")`)
- [ ] Pin / Unpin Tab — `gBrowser.pinTab(tab)` / `gBrowser.unpinTab(tab)` (check `tab.pinned`)
- [ ] Duplicate Tab — `gBrowser.duplicateTab(tab)`
- [ ] Bookmark Tab — `PlacesCommandHook.bookmarkTabs([tab])`
- [ ] Move to New Window — `gBrowser.replaceTabWithWindow(tab)`
- [ ] Copy Link — `Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(tab.linkedBrowser.currentURI.spec)`
- [ ] Close Tab — `gBrowser.removeTab(tab)`
- [ ] Reopen Closed Tab — `undoCloseTab()`

## Priority 2 — Add later

- [ ] Unload Tab — `gBrowser.discardBrowser(tab)` (saves memory)
- [ ] Separate Split View — `TabContextMenu.unsplitTabs()` (when tab is in split view)
- [ ] Close Tabs to the End — close all tabs below in the panel
- [ ] Close Other Tabs — close all except this one
- [ ] Close Duplicate Tabs
- [ ] Select All Tabs

## Deferred — skip for now

- Firefox Tab Groups (we have our own groups)
- Send Tab to Device (needs Sync setup, complex submenu)
- Reopen in Container (needs container setup, complex submenu)
- Notes (Firefox 149+ feature, niche)
- AI Chat (Nightly-only feature)
