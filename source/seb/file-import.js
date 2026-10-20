export async function importSelectedFile(file, sendMessage, tabId) {
  if (!file) throw new Error("Choose a SEB configuration file first.");
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  if (!bytes.length) throw new Error("The selected file is empty.");
  const response = await sendMessage({ type: "SEB_PROCESS_BYTES", bytes,
    filename: file.name || "configuration.seb", source: "selected file", tabId });
  if (!response?.ok) throw new Error(response?.error || "The configuration could not be loaded. Reload the extension and try again.");
  return response.state;
}
