// js/masonry.js

export function layoutCards(containerSelector = '.card-grid') {
  const container = document.querySelector(containerSelector);
  if (!container) return;

  const cards = Array.from(container.querySelectorAll('.character-card'));
  
  if (!cards.length) {
    container.style.height = '0px';
    return;
  }

  // 1. Временно отключаем transitions, чтобы избежать "прыжков" из (0,0)
  cards.forEach(card => {
    card.classList.add('no-transition');
  });

  const containerWidth = container.clientWidth;
  if (containerWidth === 0) {
    requestAnimationFrame(() => layoutCards(containerSelector));
    return;
  }

  let columns = 4;
  if (window.innerWidth < 600) columns = 1;
  else if (window.innerWidth < 900) columns = 2;
  else if (window.innerWidth < 1200) columns = 3;

  const gap = 16;
  const columnWidth = (containerWidth - (gap * (columns - 1))) / columns;
  const colHeights = new Array(columns).fill(0);

  cards.forEach((card, index) => {
    // Round Robin logic for stability
    const columnIndex = index % columns;
    
    const x = columnIndex * (columnWidth + gap);
    const y = colHeights[columnIndex];

    card.style.width = `${columnWidth}px`;
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;

    colHeights[columnIndex] += card.offsetHeight + gap;
  });

  const maxHeight = Math.max(...colHeights);
  container.style.height = `${maxHeight}px`;

  // 2. Принудительный Reflow (браузер должен применить стили до включения транзишенов)
  void container.offsetWidth; 

  // 3. Включаем transitions обратно
  cards.forEach(card => {
    card.classList.remove('no-transition');
  });
}