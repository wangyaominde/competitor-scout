(() => {
  const nav = document.querySelector('.nav');
  const onScroll = () => {
    if (!nav) return;
    nav.classList.toggle('scrolled', window.scrollY > 8);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // 轻微灯依次点亮，演示流水线
  const lamps = [...document.querySelectorAll('.lamp')];
  if (lamps.length) {
    let i = 0;
    setInterval(() => {
      lamps.forEach((el, idx) => {
        el.classList.remove('on', 'pulse');
        if (idx < i) el.classList.add('on');
        if (idx === i) el.classList.add('on', 'pulse');
      });
      i = (i + 1) % lamps.length;
    }, 900);
  }
})();
