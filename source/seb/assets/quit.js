const parameters = new URLSearchParams(location.search);
const passwordRequired = parameters.get("password") === "1";
const confirmationDialog = document.getElementById("confirmationDialog");
const passwordDialog = document.getElementById("passwordDialog");
const passwordForm = document.getElementById("passwordForm");
const password = document.getElementById("password");
const error = document.getElementById("error");

confirmationDialog.hidden = passwordRequired;
passwordDialog.hidden = !passwordRequired;
if (passwordRequired) setTimeout(() => password.focus(), 0);
else setTimeout(() => document.getElementById("yesButton").focus(), 0);

document.querySelectorAll("[data-cancel]").forEach(button => {
  button.addEventListener("click", () => parent.postMessage({type: "SEB_QUIT_CANCEL"}, "*"));
});

document.getElementById("yesButton").addEventListener("click", () => {
  parent.postMessage({type: "SEB_QUIT_SUBMIT", password: ""}, "*");
});

passwordForm.addEventListener("submit", event => {
  event.preventDefault();
  error.hidden = true;
  parent.postMessage({type: "SEB_QUIT_SUBMIT", password: password.value}, "*");
  password.value = "";
});

addEventListener("message", event => {
  if (event.source !== parent || event.data?.type !== "SEB_QUIT_ERROR") return;
  error.textContent = event.data.error;
  error.hidden = false;
  password.focus();
});
