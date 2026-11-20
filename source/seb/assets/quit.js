const parameters = new URLSearchParams(location.search);
const passwordRequired = parameters.get("password") === "1";
const confirmationDialog = document.getElementById("confirmationDialog");
const passwordDialog = document.getElementById("passwordDialog");
const passwordForm = document.getElementById("passwordForm");
const password = document.getElementById("password");
const error = document.getElementById("error");
const hideCursorOnQuit = parameters.get("hideCursorOnQuit") === "1";
let blackoutCursorStyle;
function hideCursorBeforeQuit() {
  if (!hideCursorOnQuit || blackoutCursorStyle) return;
  blackoutCursorStyle = document.createElement("style");
  blackoutCursorStyle.textContent = "html, body, body * { cursor: none !important; }";
  document.head.append(blackoutCursorStyle);
}
function restoreCursorAfterError() {
  blackoutCursorStyle?.remove();
  blackoutCursorStyle = undefined;
}
if (parameters.get("cursor") === "1") {
  const style = document.createElement("style");
  style.textContent = `html, body, body * { cursor: url("../icons/aero_arrow.png") 0 0, default !important; }
    button, button * { cursor: url("../icons/aero_link.png") 6 0, pointer !important; }
    input { cursor: url("../icons/aero_beam.png") 8 9, text !important; }`;
  document.head.append(style);
}

confirmationDialog.hidden = passwordRequired;
passwordDialog.hidden = !passwordRequired;
if (passwordRequired) setTimeout(() => password.focus(), 0);
else setTimeout(() => document.getElementById("yesButton").focus(), 0);

document.querySelectorAll("[data-cancel]").forEach(button => {
  button.addEventListener("click", () => parent.postMessage({type: "SEB_QUIT_CANCEL"}, "*"));
});

document.getElementById("yesButton").addEventListener("pointerdown", hideCursorBeforeQuit);
document.getElementById("confirmButton").addEventListener("pointerdown", hideCursorBeforeQuit);
document.getElementById("yesButton").addEventListener("click", () => {
  hideCursorBeforeQuit();
  parent.postMessage({type: "SEB_QUIT_SUBMIT", password: ""}, "*");
});

passwordForm.addEventListener("submit", event => {
  event.preventDefault();
  hideCursorBeforeQuit();
  error.hidden = true;
  parent.postMessage({type: "SEB_QUIT_SUBMIT", password: password.value}, "*");
  password.value = "";
});

addEventListener("message", event => {
  if (event.source !== parent || event.data?.type !== "SEB_QUIT_ERROR") return;
  restoreCursorAfterError();
  error.textContent = event.data.error;
  error.hidden = false;
  if (passwordRequired) password.focus();
  else document.getElementById("yesButton").focus();
});
