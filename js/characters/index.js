// js/characters/index.js

import { renderCharacters as renderGrid } from '../characters.js'; // Основной файл рендера
import { openCharacterForm } from './formEditor.js';
import { openCharacterProfile } from './profileView.js';

export function bindCharactersModule() {
  const addBtn = document.getElementById('add-character-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      openCharacterForm(null);
    });
  }
  
  // Инициализация первого рендера
  renderGrid();
}

// Экспортируем основные функции для использования снаружи
export { renderGrid, openCharacterForm, openCharacterProfile };