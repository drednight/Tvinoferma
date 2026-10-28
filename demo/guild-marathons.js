// Только вымышленные данные. Реальные голосования и сетевые запросы здесь не выполняются.
import { guildPollHtml } from '../js/modules/guild/poll.js';

const slot = document.querySelector('#poll-slot');
const status = document.querySelector('.demo-message');
const controls = document.querySelector('.demo-poll-controls');
const examples = {
  multiple: {
    id: '901',
    title: [{ text: 'Выберите подходящие варианты: ' }, { text: 'подробности', href: 'https://example.com/details' }],
    type: 'multiple',
    options: [
      { id: '501', text: [{ text: 'Вариант А' }], selected: true },
      { id: '502', text: [{ text: 'Вариант Б — ' }, { text: 'пример ссылки', href: 'https://example.com/option' }] },
      { id: '503', text: [{ text: 'Вариант В' }] }
    ]
  },
  single: {
    id: '902',
    title: [{ text: 'Выберите один из вариантов' }],
    type: 'single',
    options: [
      { id: '511', text: [{ text: 'Вариант А' }] },
      { id: '512', text: [{ text: 'Вариант Б' }] }
    ]
  },
  none: null,
  error: { id: '903', title: [{ text: 'Пример недоступного опроса' }], type: 'single', options: [], loadError: true }
};
let current = 'multiple';
function render() {
  slot.innerHTML = guildPollHtml(examples[current]);
  controls
    .querySelectorAll('button')
    .forEach(button => button.setAttribute('aria-pressed', String(button.dataset.example === current)));
}
controls.addEventListener('click', event => {
  const button = event.target.closest('button[data-example]');
  if (!button) return;
  current = button.dataset.example;
  status.textContent = '';
  render();
});
slot.addEventListener('submit', event => {
  event.preventDefault();
  const chosen = [...event.target.querySelectorAll('input:checked')].map(input => input.value);
  if (!chosen.length) {
    status.textContent = 'Выберите вариант ответа в примере.';
    return;
  }
  examples[current].options.forEach(option => (option.selected = chosen.includes(option.id)));
  render();
  status.textContent = 'Демонстрационный голос учтён только на этой странице.';
});
render();
