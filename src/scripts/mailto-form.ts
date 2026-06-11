// 將標記 data-mailto-form 的表單轉為 mailto: 寄信。
// 純靜態網站無後端，改以使用者本機郵件軟體送出，避免依賴第三方表單服務。
function buildMailtoHref(form: HTMLFormElement): string {
  const to = form.dataset.mailto ?? '';
  const subject = form.dataset.subject ?? '';
  const fields = form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-label]');

  const lines: string[] = [];
  fields.forEach((field) => {
    const value = field.value.trim();
    if (value) lines.push(`${field.dataset.label}：${value}`);
  });

  const body = lines.join('\n');
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

document.querySelectorAll<HTMLFormElement>('form[data-mailto-form]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // 沿用瀏覽器原生欄位驗證（required / type=email 等）
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    window.location.href = buildMailtoHref(form);
  });
});
