const DEFAULT_APP_ID = '936619743392459';

const hoursInput = document.getElementById('hours');
const appIdInput = document.getElementById('appId');
const saved = document.getElementById('saved');

chrome.storage.local.get(['maxAgeHours', 'appId'], ({ maxAgeHours, appId }) => {
    if (maxAgeHours) hoursInput.value = maxAgeHours;
    appIdInput.value = appId ?? DEFAULT_APP_ID;
});

document.getElementById('save').addEventListener('click', () => {
    const hours = Math.max(1, Math.min(168, parseInt(hoursInput.value) || 48));
    const appId = appIdInput.value.trim() || DEFAULT_APP_ID;
    hoursInput.value = hours;
    appIdInput.value = appId;
    // Clear feed cache so next open re-fetches with new settings
    chrome.storage.local.set({ maxAgeHours: hours, appId, feedCache: null }, () => {
        saved.style.display = 'block';
        setTimeout(() => { saved.style.display = 'none'; }, 3000);
    });
});
