// js/components/ProgressBar.js

export class ProgressBar {
    constructor() {
        this.container = null;
        this.bar = null;
        this.text = null;
        this.isOpen = false;
    }

    show(title) {
        if (this.isOpen) return;

        this.container = document.createElement('div');
        this.container.style.cssText = `
            position: fixed; top: 20px; right: 20px; z-index: 9999;
            background: var(--panel); border: 1px solid var(--accent);
            padding: 15px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            width: 300px; font-family: sans-serif; color: var(--text-primary);
            transition: opacity 0.3s;
        `;
        
        this.titleEl = document.createElement('h4');
        this.titleEl.textContent = title;
        this.titleEl.style.marginTop = '0';
        this.titleEl.style.fontSize = '0.9rem';
        this.titleEl.style.color = 'var(--accent)';

        this.progressWrap = document.createElement('div');
        this.progressWrap.style.cssText = `
            background: rgba(255,255,255,0.1); height: 8px; border-radius: 4px; overflow: hidden; margin-bottom: 8px;
        `;

        this.bar = document.createElement('div');
        this.bar.style.cssText = `
            background: var(--success, #9ece6a); height: 100%; width: 0%; transition: width 0.2s ease-out;
        `;

        this.textEl = document.createElement('p');
        this.textEl.style.cssText = `margin: 0; font-size: 0.8rem; text-align: center;`;
        this.textEl.textContent = '0%';

        this.progressWrap.appendChild(this.bar);
        this.container.appendChild(this.titleEl);
        this.container.appendChild(this.progressWrap);
        this.container.appendChild(this.textEl);
        
        document.body.appendChild(this.container);
        this.isOpen = true;
    }

    update(current, total, message = '') {
        if (!this.isOpen) return;
        const percent = Math.round((current / total) * 100);
        this.bar.style.width = `${percent}%`;
        this.textEl.textContent = `${percent}% (${current}/${total}) ${message}`;
    }

    hide() {
        if (this.container) {
            this.container.remove();
            this.isOpen = false;
        }
    }
}