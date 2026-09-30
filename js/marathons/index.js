// js/marathons/index.js

import { showModal, toast } from '../ui.js'; // Путь: js -> marathons -> ui.js
import { persist } from '../storage.js';     // Путь: js -> marathons -> storage.js
import { renderMarathons } from '../marathon.js'; // Путь: js -> marathons -> marathon.js
import { state } from '../state.js';         // Путь: js -> marathons -> state.js
import { MarathonFormState } from './stateManager.js';
import { renderInfoStep } from './steps/infoStep.js';
import { renderParticipantsStep } from './steps/participantsStep.js';

export function openMarathonForm(marathon = null) {
  // ЛОГИКА ОПРЕДЕЛЕНИЯ РЕЖИМА:
  // Если marathon передан И у него есть реальный ID (не null, не undefined), то это EDIT.
  // Иначе это CREATE (даже если данные предзаполнены).
  
  const isNew = !marathon || !marathon.id; 
  const isEdit = !isNew; 
  
  // Инициализация состояния формы
  // Если это NEW, но есть данные (prefill), используем их как основу, но сбрасываем ID
  const initialDataForState = isEdit ? marathon : (marathon ? { ...marathon, id: null } : null);
  
  const formState = new MarathonFormState(initialDataForState);

  // Получаем список персонажей...
  const charactersList = state.characters.map(c => ({
    id: c.id, 
    nick: c.nick, 
    class: c.class, 
    party: c.party
  })).sort((a, b) => a.nick.localeCompare(b.nick, 'ru'));

  const uniqueParties = Array.from(new Set(state.characters.map(c => c.party).filter(Boolean)));

  // Шаблон контента модального окна...
  const contentTemplate = () => `
    <div class="form-grid">
      <!-- ТАБЫ НАВИГАЦИИ -->
      <div style="display:flex; gap:10px; margin-bottom:20px; border-bottom:1px solid var(--border); padding-bottom:10px;">
        <button type="button" class="btn ${formState.currentTab === 'info' ? 'primary' : 'ghost'} step-tab-btn" data-step="info">📋 Информация о марафоне</button>
        <button type="button" class="btn ${formState.currentTab === 'participants' ? 'primary' : 'ghost'} step-tab-btn" data-step="participants">👥 Участники и Задания</button>
      </div>
      <!-- КОНТЕЙНЕР ДЛЯ ТЕЛА ФОРМЫ -->
      <div id="dynamic-form-content"></div>
    </div>
  `;

  // Открытие модального окна
  showModal({
    title: isEdit ? 'Редактировать марафон' : 'Новый марафон',
    content: contentTemplate(),
    submitText: 'Сохранить',
    onSubmit(formData, { setError }) {
      try {
        // 1. Синхронизируем данные из текущего DOM
        formState.syncFromDOM('#dynamic-form-content');
        
        // 2. Валидация
        const errors = formState.validate();
        if (errors.length > 0) {
          setError(errors.join('\n'));
          return false;
        }

        // 3. Подготовка финальных данных
        const finalData = { ...formState.data, updatedAt: new Date().toISOString() };
        
        // Сохраняем старый статус, чтобы понять, был ли марафон завершен ранее
        const wasCompleted = isEdit && marathon.status === 'completed';

        // 4. Запись в глобальный стейт
        if (isEdit) {
          const idx = state.marathons.findIndex(m => m.id === marathon.id);
          if (idx !== -1) {
             state.marathons[idx] = finalData;
          } else {
             throw new Error("Марафон для редактирования не найден");
          }
        } else {
          // СОЗДАНИЕ НОВОГО МАРАФОНА
          // Генерируем новый ID, если его еще нет
          if (!finalData.id) {
              finalData.id = crypto.randomUUID(); 
          }
          state.marathons.push(finalData);
        }

        // 5. ЕСЛИ МРАФОН БЫЛ ЗАВЕРШЕН - ПЕРЕССЧИТЫВАЕМ МОНЕТЫ
        if (wasCompleted) {
           console.log('[SAVE] Marathon was completed. Triggering award recalculation...');
           
           import('../marathonRewards.js').then(mod => {
              mod.recalculateMarathonAwards(finalData.id);
              
              persist().then(() => {
                renderMarathons();
                toast('Марафон обновлен. Монеты пересчитаны.', 'success');
              });
           }).catch(err => {
              console.error('[RECALC ERROR]', err);
              toast('Ошибка при пересчете наград', 'error');
           });
           
           return true; 
        }

        // 6. Обычное сохранение
        persist().then(() => {
          renderMarathons();
          toast(isEdit ? 'Марафон обновлен' : 'Марафон создан', 'success');
        });
        
        return true;

      } catch (err) {
        console.error('[MARATHON FORM SAVE ERROR]', err);
        setError(`Ошибка сохранения: ${err.message}`);
        return false;
      }
    }
  });

  // --- ЛОГИКА РЕНДЕРА И ПЕРЕКЛЮЧЕНИЯ ТАБОВ ---
  function rerenderContent() {
    const container = document.getElementById('dynamic-form-content');
    if(!container) return;
    
    container.innerHTML = ''; 

    if (formState.currentTab === 'info') {
      renderInfoStep(
        container, 
        formState, 
        () => {
          formState.addTask();
          rerenderContent(); 
        }
      );
    } else {
      renderParticipantsStep(
        container, 
        formState, 
        charactersList, 
        uniqueParties
      );
    }
  }

  rerenderContent();

  setTimeout(() => {
    const tabButtons = document.querySelectorAll('.step-tab-btn');
    
    tabButtons.forEach(btn => {
      btn.onclick = () => {
        const targetStep = btn.dataset.step;
        if (targetStep === formState.currentTab) return;

        formState.switchTab(targetStep);
        
        tabButtons.forEach(b => {
          const isActive = b.dataset.step === targetStep;
          b.classList.toggle('primary', isActive);
          b.classList.toggle('ghost', !isActive);
        });

        rerenderContent();
      };
    });
  }, 0);
}