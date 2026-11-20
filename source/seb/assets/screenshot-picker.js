const input = document.querySelector("#file");
const status = document.querySelector("#status");
const preview = document.querySelector("#preview");
input.addEventListener("change", async () => {
  const file = input.files?.[0];
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 25 * 1024 * 1024) {
    status.textContent = "Choose a PNG, JPEG, WebP or GIF under 25 MB.";
    return;
  }
  input.disabled = true;
  status.textContent = "Saving screenshot…";
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    await browser.storage.local.set({ oebQuitScreenshot: { name: file.name, dataUrl } });
    preview.src = dataUrl;
    preview.hidden = false;
    status.textContent = `${file.name} saved. You can close this tab.`;
  } catch (error) { status.textContent = `Could not save screenshot: ${error.message}`; }
  finally { input.disabled = false; }
});
(async () => {
  const saved = (await browser.storage.local.get("oebQuitScreenshot")).oebQuitScreenshot;
  if (saved?.dataUrl) { preview.src = saved.dataUrl; preview.hidden = false; status.textContent = `Current screenshot: ${saved.name}`; }
})();
