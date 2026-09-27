// js/marathons/index.js

import { showModal, toast } from '../ui.js'; // Путь: js -> marathons -> ui.js
import { persist } from '../storage.js';     // Путь: js -> marathons -> storage.js
import { renderMarathons } from '../marathon.js'; // Путь: js -> marathons -> marathon.js
import { state } from '../state.js';         // Путь: js -> marathons -> state.js
import { MarathonFormState } from './stateManager.js';
import { renderInfoStep } from './steps/infoStep.js';
import { renderParticipantsStep } from './steps/participantsStep.js';

export function openMarathonForm(marathon = null) {
  const isEdit = !!marathon;
  
  // Инициализация состояния формы
  const formState = new MarathonFormState(marathon);

  // Получаем список персонажей из глобального стейта
  // Теперь это доступно сразу, без асинхронных ожиданий
  const charactersList = state.characters.map(c => ({
    id: c.id, 
    nick: c.nick, 
    class: c.class, 
    party: c.party
  })).sort((a, b) => a.nick.localeCompare(b.nick, 'ru'));

  const uniqueParties = Array.from(new Set(state.characters.map(c => c.party).filter(Boolean)));

  // Шаблон контента модального окна (с табами навигации)
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
          state.marathons.push(finalData);
        }

        // 5. ЕСЛИ МРАФОН БЫЛ ЗАВЕРШЕН - ПЕРЕССЧИТЫВАЕМ МОНЕТЫ
        if (wasCompleted) {
           console.log('[SAVE] Marathon was completed. Triggering award recalculation...');
           
           // Импортируем функцию динамически, чтобы избежать циклических зависимостей при загрузке модулей
           import('../marathonRewards.js').then(mod => {
              mod.recalculateMarathonAwards(finalData.id);
              
              // После пересчета сохраняем всё на диск
              persist().then(() => {
                renderMarathons();
                toast('Марафон обновлен. Монеты пересчитаны.', 'success');
              });
           }).catch(err => {
              console.error('[RECALC ERROR]', err);
              toast('Ошибка при пересчете наград', 'error');
           });
           
           // Возвращаем true, чтобы закрыть модалку (асинхронная работа продолжится в фоне)
           return true; 
        }

        // 6. Обычное сохранение (если марафон активен или новый)
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

  // Функция перерисовки содержимого в зависимости от активного таба
  function rerenderContent() {
    const container = document.getElementById('dynamic-form-content');
    if(!container) return;
    
    container.innerHTML = ''; // Очищаем текущее содержимое

    if (formState.currentTab === 'info') {
      renderInfoStep(
        container, 
        formState, 
        () => {
          // Колбэк при добавлении нового задания
          formState.addTask();
          rerenderContent(); // Перерисовываем, чтобы показать новую карточку
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

  // Инициализация первого рендера
  rerenderContent();

  // Привязка обработчиков кликов на кнопки табов
  setTimeout(() => {
    const tabButtons = document.querySelectorAll('.step-tab-btn');
    
    tabButtons.forEach(btn => {
      btn.onclick = () => {
        const targetStep = btn.dataset.step;
        
        // Если кликнули по уже активному табу — ничего не делаем
        if (targetStep === formState.currentTab) return;

        // Меняем состояние
        formState.switchTab(targetStep);
        
        // Обновляем визуальное состояние кнопок (Primary/Ghost)
        tabButtons.forEach(b => {
          const isActive = b.dataset.step === targetStep;
          b.classList.toggle('primary', isActive);
          b.classList.toggle('ghost', !isActive);
        });

        // Перерисовываем контент
        rerenderContent();
      };
    });
  }, 0); // Небольшая задержка гарантирует, что DOM уже отрендерился
}