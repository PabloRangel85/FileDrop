const uploadView = document.querySelector('#upload-view');
const downloadView = document.querySelector('#download-view');

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${units[unitIndex]}`;
}

function initializeUpload() {
  const form = document.querySelector('#upload-form');
  const fileInput = document.querySelector('#file-input');
  const dropZone = document.querySelector('#drop-zone');
  const fileLabel = document.querySelector('#file-label');
  const fileHint = document.querySelector('#file-hint');
  const fileMeta = document.querySelector('#file-meta');
  const submitButton = document.querySelector('#submit-button');
  const submitLabel = document.querySelector('#submit-label');
  const formError = document.querySelector('#form-error');
  const resultPanel = document.querySelector('#result-panel');
  const segments = [...document.querySelectorAll('.segment')];
  let expirationType = 'time';

  function setFile(file) {
    if (!file) return;
    const maxBytes = 100 * 1024 * 1024;
    if (file.size > maxBytes) {
      formError.textContent = 'Este arquivo ultrapassa o limite de 100 MB.';
      formError.hidden = false;
      return;
    }
    fileInput.files = createFileList(file);
    fileLabel.textContent = file.name;
    fileHint.textContent = 'Arquivo selecionado';
    fileMeta.textContent = formatBytes(file.size);
    formError.hidden = true;
  }

  function createFileList(file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    return dataTransfer.files;
  }

  fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
  dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  for (const eventName of ['dragenter', 'dragover']) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add('is-dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove('is-dragging');
    });
  }
  dropZone.addEventListener('drop', (event) => setFile(event.dataTransfer.files[0]));

  segments.forEach((segment) => {
    segment.addEventListener('click', () => {
      expirationType = segment.dataset.mode;
      segments.forEach((item) => {
        const selected = item === segment;
        item.classList.toggle('is-active', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      document.querySelector('#time-control').hidden = expirationType !== 'time';
      document.querySelector('#downloads-control').hidden = expirationType !== 'downloads';
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    formError.hidden = true;
    if (!fileInput.files[0]) {
      formError.textContent = 'Escolha um arquivo antes de continuar.';
      formError.hidden = false;
      return;
    }

    const body = new FormData();
    body.append('file', fileInput.files[0]);
    body.append('expirationType', expirationType);
    if (expirationType === 'time') {
      body.append('expiresInHours', document.querySelector('#expires-in').value);
    } else {
      body.append('maxDownloads', document.querySelector('#max-downloads').value);
    }

    submitButton.disabled = true;
    submitLabel.textContent = 'Enviando arquivo...';
    try {
      const response = await fetch('/api/transfers', { method: 'POST', body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Nao foi possivel enviar o arquivo.');

      const shareLink = document.querySelector('#share-link');
      shareLink.value = result.shareUrl;
      const expiryText = result.expiresAt
        ? `Expira em ${new Date(result.expiresAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`
        : `Disponivel para ${result.maxDownloads} downloads`;
      document.querySelector('#result-expiry').textContent = expiryText;
      resultPanel.hidden = false;
      form.querySelector('.drop-zone').hidden = true;
      form.querySelector('.expiry-fieldset').hidden = true;
      submitButton.hidden = true;
    } catch (error) {
      formError.textContent = error.message;
      formError.hidden = false;
    } finally {
      submitButton.disabled = false;
      submitLabel.textContent = 'Criar link';
    }
  });

  document.querySelector('#copy-button').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const linkInput = document.querySelector('#share-link');
    try {
      await navigator.clipboard.writeText(linkInput.value);
    } catch {
      linkInput.select();
      document.execCommand('copy');
    }
    button.setAttribute('aria-label', 'Link copiado');
    button.title = 'Link copiado';
    window.setTimeout(() => {
      button.setAttribute('aria-label', 'Copiar link');
      button.title = 'Copiar link';
    }, 1800);
  });

  document.querySelector('#new-transfer-button').addEventListener('click', () => window.location.reload());
}

async function initializeDownload(code) {
  const title = document.querySelector('#download-title');
  const copy = document.querySelector('#download-copy');
  const facts = document.querySelector('#download-facts');
  const button = document.querySelector('#download-button');

  try {
    const response = await fetch(`/api/transfers/${encodeURIComponent(code)}`);
    const transfer = await response.json();
    if (!response.ok) throw new Error(transfer.error || 'Este link nao esta mais disponivel.');

    title.textContent = transfer.filename;
    copy.textContent = 'O arquivo esta pronto para baixar.';
    facts.textContent = transfer.expiresAt
      ? `Expira em ${new Date(transfer.expiresAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}  ·  ${formatBytes(transfer.sizeBytes)}`
      : `${transfer.remainingDownloads} ${transfer.remainingDownloads === 1 ? 'download restante' : 'downloads restantes'}  ·  ${formatBytes(transfer.sizeBytes)}`;
    facts.hidden = false;
    button.href = `/api/download/${encodeURIComponent(code)}`;
    button.hidden = false;
  } catch (error) {
    title.textContent = 'Link indisponivel';
    copy.textContent = error.message;
  }
}

const downloadMatch = window.location.pathname.match(/^\/d\/([^/]+)\/?$/);
if (downloadMatch) {
  uploadView.hidden = true;
  downloadView.hidden = false;
  initializeDownload(decodeURIComponent(downloadMatch[1]));
} else {
  initializeUpload();
}