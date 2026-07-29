(function () {
  const zone = document.getElementById("drop-zone");
  const input = document.getElementById("file-input");
  const form = document.getElementById("upload-form");
  const statusEl = document.getElementById("upload-status");
  let dragDepth = 0; // guards against dragleave firing when moving between child elements

  zone.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  zone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    zone.classList.add("drag-active");
  });
  zone.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) zone.classList.remove("drag-active");
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    zone.classList.remove("drag-active");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (ext !== ".xlsx" && ext !== ".xlsm") {
      statusEl.textContent = "File must be an .xlsx or .xlsm workbook.";
      return;
    }
    try {
      input.files = e.dataTransfer.files;
    } catch (err) {
      statusEl.textContent = "Could not attach the dropped file in this browser — please use the file picker instead.";
      return;
    }
    statusEl.textContent = `Uploading "${file.name}"...`;
    form.requestSubmit();
  });
})();
