// background.js
// アイコンクリック時にビューワーを開く

chrome.action.onClicked.addListener(async (tab) => {
    const viewerUrl = chrome.runtime.getURL("index.html");
    await chrome.tabs.create({ url: viewerUrl });
});
