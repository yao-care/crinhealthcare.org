// 清單放不下時的自動輪播（kiosk 無人操作，靠時間換頁把內容輪完）。
// 放得下就完全不動作——不是「一律捲」，是「溢出才捲」。
// EmsBoardV2 使用端卡片與 EmsWarPlan 供電清單共用這一份，避免兩邊各寫一套捲法。
export function carousel(node: HTMLElement, delay = 5000) {
  const id = setInterval(() => {
    const max = node.scrollHeight - node.clientHeight;
    if (max <= 4) return; // 放得下，不輪播
    // 已到底→回頂；否則前進約一頁，但夾在底部內（內容僅略微溢出時，一頁步距會超過總溢出量，
    // 不夾住會誤判成「該歸零」而永遠停在頂端）
    const next = node.scrollTop >= max - 2 ? 0 : Math.min(node.scrollTop + node.clientHeight * 0.92, max);
    node.scrollTo({ top: next, behavior: 'smooth' });
  }, delay);
  return { destroy() { clearInterval(id); } };
}
