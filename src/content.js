const TAG = "🚀 [IG-CORE]";

try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/injected.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
    console.log(`${TAG} ✅ 注入成功`);
} catch (e) {
    console.error(`${TAG} ❌ 注入失败`, e);
}
