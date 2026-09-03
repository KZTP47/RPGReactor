/**
 * DatabaseQuestEditor - Database > Quests.
 *
 * A quest is a record in data/Quests.json (Reactor's own file, beside the
 * MZ database): who gives it and where, a description, objectives and
 * rewards that can start hidden, and the rules that make it appear and
 * complete. The runtime (reactor_quests.js) reads this shape as it is.
 */
class DatabaseQuestEditor {
    constructor(databaseManager, projectManager, commonUI, parentEditor) {
        this.databaseManager = databaseManager;
        this.projectManager = projectManager;
        this.commonUI = commonUI;
        this.parentEditor = parentEditor;
        this._pickers = null;
    }

    _t(text, params) {
        let value = window.I18n ? window.I18n.tText(text) : text;
        for (const [key, replacement] of Object.entries(params || {})) value = value.split(`{${key}}`).join(String(replacement));
        return value;
    }

    _project() {
        return this.projectManager && this.projectManager.getCurrentProject
            ? this.projectManager.getCurrentProject() : (this.projectManager && this.projectManager.currentProject);
    }

    /** A record with every field the runtime may read, old or new. */
    static normalize(quest) {
        if (!quest) return quest;
        quest.name = quest.name || '';
        quest.key = quest.key || '';
        quest.category = quest.category || '';
        quest.iconIndex = Number(quest.iconIndex) || 0;
        quest.difficulty = quest.difficulty || '';
        quest.from = quest.from || '';
        quest.location = quest.location || '';
        quest.description = quest.description || '';
        quest.objectives = Array.isArray(quest.objectives) ? quest.objectives : [];
        quest.rewards = Array.isArray(quest.rewards) ? quest.rewards : [];
        quest.subtext = quest.subtext || '';
        quest.quotes = quest.quotes || '';
        quest.activation = Object.assign({ type: 'command', switchId: 0, variableId: 0, operator: '>=', value: 0 }, quest.activation || {});
        quest.completion = Object.assign({ type: 'command', switchId: 0 }, quest.completion || {});
        quest.note = quest.note || '';
        return quest;
    }

    /** The project's quest log settings, stored on System.json. */
    settings() {
        const system = this.databaseManager.getSystem() || {};
        if (!system.reactorQuests || typeof system.reactorQuests !== 'object') system.reactorQuests = {};
        const stored = system.reactorQuests;
        if (stored.menuCommand === undefined) stored.menuCommand = true;
        if (!stored.commandName) stored.commandName = 'Quests';
        return stored;
    }

    switchName(id) {
        const list = (this.databaseManager.getSystem() || {}).switches || [];
        return id > 0 ? `#${String(id).padStart(4, '0')}${list[id] ? ' ' + list[id] : ''}` : this._t('(none)');
    }

    variableName(id) {
        const list = (this.databaseManager.getSystem() || {}).variables || [];
        return id > 0 ? `#${String(id).padStart(4, '0')}${list[id] ? ' ' + list[id] : ''}` : this._t('(none)');
    }

    iconHtml(index) {
        const codes = window.RRIconCodes;
        if (!codes || !(index > 0)) return `<span style="display:inline-block;width:32px;height:32px;border:1px dashed var(--color-border);border-radius:3px;"></span>`;
        return `<span class="rr-icon-code" style="${rrEscapeHtml(codes.cellCss(index, codes.iconSetUrl(), 32))}"></span>`;
    }

    showQuestDetail(container, quest) {
        const tt = text => this._t(text);
        DatabaseQuestEditor.normalize(quest);
        const settings = this.settings();
        container.innerHTML = '';
        const wrapper = document.createElement('div');
        wrapper.className = 'database-detail-wrapper db-page';

        // The quest log's own settings and the importer sit above every quest:
        // they are the project's, not this record's.
        const strip = document.createElement('div');
        strip.className = 'database-section';
        strip.innerHTML = `
            <div class="database-section-header">${tt('Quest Log')}</div>
            <div class="database-section-content"><div class="db-form">
                <div class="db-row-cols">
                    <span class="db-col">
                        <label>${tt('Show in the main menu')}</label>
                        <input type="checkbox" class="system-checkbox" data-quest-setting="menuCommand" ${settings.menuCommand !== false ? 'checked' : ''}>
                    </span>
                    <span class="db-col">
                        <label>${tt('Menu command name')}</label>
                        <input type="text" class="database-field-value" data-quest-setting="commandName" value="${rrEscapeHtml(settings.commandName)}">
                    </span>
                    <span class="db-col" style="align-self:end;">
                        <button type="button" class="rr-btn-secondary quest-import" title="${rrEscapeHtml(tt('Read the quests another plugin stores in this project and add them here.'))}">${tt('Import from VisuStella…')}</button>
                    </span>
                </div>
            </div></div>`;
        wrapper.appendChild(strip);

        const grid = document.createElement('div');
        grid.className = 'db-page-grid';

        const general = document.createElement('div');
        general.className = 'database-section';
        general.innerHTML = `
            <div class="database-section-header">${tt('General')}</div>
            <div class="database-section-content"><div class="db-general-grid">
                <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
                    <label style="font-size:11px;color:var(--color-text-muted);font-weight:600;">${tt('Icon')}</label>
                    <div class="quest-icon" style="cursor:pointer;" title="${rrEscapeHtml(tt('Click to choose an icon'))}">${this.iconHtml(quest.iconIndex)}</div>
                </div>
                <div class="db-form db-fill">
                    <div class="db-row-cols">
                        <span class="db-col"><label>${tt('Name')}</label><input type="text" class="database-field-value" value="${rrEscapeHtml(quest.name)}" data-field="name" data-quest-id="${quest.id}"></span>
                        <span class="db-col"><label>${tt('Key')}</label><input type="text" class="database-field-value" value="${rrEscapeHtml(quest.key)}" data-field="key" data-quest-id="${quest.id}" placeholder="${rrEscapeHtml(tt('for scripts and imports'))}"></span>
                    </div>
                    <div class="db-row-cols">
                        <span class="db-col"><label>${tt('Category')}</label><input type="text" class="database-field-value" value="${rrEscapeHtml(quest.category)}" data-field="category" data-quest-id="${quest.id}" list="quest-categories-${quest.id}"><datalist id="quest-categories-${quest.id}">${this.categoryOptions()}</datalist></span>
                        <span class="db-col"><label>${tt('Difficulty')}</label><input type="text" class="database-field-value" value="${rrEscapeHtml(quest.difficulty)}" data-field="difficulty" data-quest-id="${quest.id}"></span>
                    </div>
                    <div class="db-row-cols">
                        <span class="db-col"><label>${tt('From')}</label><input type="text" class="database-field-value" value="${rrEscapeHtml(quest.from)}" data-field="from" data-quest-id="${quest.id}"></span>
                        <span class="db-col"><label>${tt('Location')}</label><input type="text" class="database-field-value" value="${rrEscapeHtml(quest.location)}" data-field="location" data-quest-id="${quest.id}"></span>
                    </div>
                </div>
            </div></div>`;
        grid.appendChild(general);

        const rules = document.createElement('div');
        rules.className = 'database-section';
        rules.innerHTML = `
            <div class="database-section-header">${tt('Rules')}</div>
            <div class="database-section-content"><div class="db-form">
                <div class="db-row-cols">
                    <span class="db-col">
                        <label>${tt('Appears')}</label>
                        <select class="database-field-value" data-field="activation.type" data-quest-id="${quest.id}">
                            ${this.options([['command', tt('Only by event command')], ['start', tt('At the start of the game')], ['switch', tt('When a switch is ON')], ['variable', tt('When a variable reaches a value')]], quest.activation.type)}
                        </select>
                    </span>
                    <span class="db-col quest-when-switch" ${quest.activation.type === 'switch' ? '' : 'hidden'}>
                        <label>${tt('Switch')}</label>
                        <button type="button" class="rr-btn-secondary quest-pick" data-pick="switch" data-target="activation.switchId">${rrEscapeHtml(this.switchName(quest.activation.switchId))}</button>
                    </span>
                    <span class="db-col quest-when-variable" ${quest.activation.type === 'variable' ? '' : 'hidden'}>
                        <label>${tt('Variable')}</label>
                        <button type="button" class="rr-btn-secondary quest-pick" data-pick="variable" data-target="activation.variableId">${rrEscapeHtml(this.variableName(quest.activation.variableId))}</button>
                    </span>
                    <span class="db-col quest-when-variable" ${quest.activation.type === 'variable' ? '' : 'hidden'}>
                        <label>${tt('Is')}</label>
                        <select class="database-field-value" data-field="activation.operator" data-quest-id="${quest.id}">
                            ${this.options([['>=', '≥'], ['==', '='], ['<=', '≤'], ['>', '>'], ['<', '<'], ['!=', '≠']], quest.activation.operator)}
                        </select>
                    </span>
                    <span class="db-col quest-when-variable" ${quest.activation.type === 'variable' ? '' : 'hidden'}>
                        <label>${tt('Value')}</label>
                        <input type="number" class="database-field-value" value="${rrEscapeHtml(quest.activation.value)}" data-field="activation.value" data-quest-id="${quest.id}">
                    </span>
                </div>
                <div class="db-row-cols">
                    <span class="db-col">
                        <label>${tt('Completes')}</label>
                        <select class="database-field-value" data-field="completion.type" data-quest-id="${quest.id}">
                            ${this.options([['command', tt('Only by event command')], ['objectives', tt('When every shown objective is complete')], ['switch', tt('When a switch is ON')]], quest.completion.type)}
                        </select>
                    </span>
                    <span class="db-col quest-done-switch" ${quest.completion.type === 'switch' ? '' : 'hidden'}>
                        <label>${tt('Switch')}</label>
                        <button type="button" class="rr-btn-secondary quest-pick" data-pick="switch" data-target="completion.switchId">${rrEscapeHtml(this.switchName(quest.completion.switchId))}</button>
                    </span>
                </div>
            </div></div>`;
        grid.appendChild(rules);

        const description = document.createElement('div');
        description.className = 'database-section';
        description.innerHTML = `
            <div class="database-section-header">${tt('Description')}</div>
            <div class="database-section-content"><div class="db-form">
                <div class="db-row-cols">
                    <span class="db-col">
                        <label>${tt('Description')}</label>
                        <textarea class="database-field-value" rows="5" data-field="description" data-quest-id="${quest.id}" data-rr-textcodes="help">${rrEscapeHtml(quest.description)}</textarea>
                        <div data-rr-textcodes-panel="help" style="margin-top:4px;"></div>
                    </span>
                </div>
            </div></div>`;
        grid.appendChild(description);

        grid.appendChild(this.listSection(quest, 'objectives', tt('Objectives'), tt('Add Objective')));
        grid.appendChild(this.listSection(quest, 'rewards', tt('Rewards'), tt('Add Reward')));

        const more = document.createElement('div');
        more.className = 'database-section';
        more.innerHTML = `
            <div class="database-section-header">${tt('Extra Text')}</div>
            <div class="database-section-content"><div class="db-form">
                <div class="db-row-cols">
                    <span class="db-col"><label>${tt('Subtext')}</label><textarea class="database-field-value" rows="3" data-field="subtext" data-quest-id="${quest.id}" data-rr-textcodes="help">${rrEscapeHtml(quest.subtext)}</textarea></span>
                </div>
                <div class="db-row-cols">
                    <span class="db-col"><label>${tt('Quotes')}</label><textarea class="database-field-value" rows="3" data-field="quotes" data-quest-id="${quest.id}" data-rr-textcodes="help">${rrEscapeHtml(quest.quotes)}</textarea></span>
                </div>
            </div></div>`;
        grid.appendChild(more);

        const note = document.createElement('div');
        note.className = 'database-section';
        note.innerHTML = `
            <div class="database-section-header">${tt('Note')}</div>
            <div class="database-section-content"><div class="db-form">
                <div class="db-row-cols">
                    <span class="db-col">
                        <label>${tt('Note')}</label>
                        <textarea class="database-field-value" rows="4" data-field="note" data-quest-id="${quest.id}">${rrEscapeHtml(quest.note)}</textarea>
                    </span>
                </div>
            </div></div>`;
        grid.appendChild(note);

        wrapper.appendChild(grid);
        container.appendChild(wrapper);
        this.attachListeners(container, quest);
    }

    options(pairs, current) {
        return pairs.map(([value, label]) => `<option value="${rrEscapeHtml(value)}"${String(value) === String(current) ? ' selected' : ''}>${rrEscapeHtml(label)}</option>`).join('');
    }

    categoryOptions() {
        const seen = new Set();
        for (const quest of this.databaseManager.getQuests()) {
            const name = String((quest && quest.category) || '').trim();
            if (name) seen.add(name);
        }
        return Array.from(seen).map(name => `<option value="${rrEscapeHtml(name)}"></option>`).join('');
    }

    /** Objectives and rewards: a row each, in the order the player sees them. */
    listSection(quest, kind, title, addLabel) {
        const tt = text => this._t(text);
        const section = document.createElement('div');
        section.className = 'database-section';
        section.dataset.questList = kind;
        const rows = (quest[kind] || []).map((entry, index) => `
            <div class="quest-row" data-index="${index}" style="display:grid;grid-template-columns:22px minmax(0,1fr) auto auto auto auto;gap:8px;align-items:center;">
                <span style="color:var(--color-text-muted);font-size:11px;text-align:right;">${index + 1}.</span>
                <input type="text" class="database-field-value" style="width:100%;min-width:0;" value="${rrEscapeHtml(entry && entry.text ? entry.text : '')}" data-list="${kind}" data-index="${index}" data-prop="text" data-rr-textcodes="help">
                <label style="display:flex;align-items:center;gap:4px;font-size:11px;white-space:nowrap;color:var(--color-text-muted);" title="${rrEscapeHtml(tt('Not shown until an event command or a switch reveals it.'))}">
                    <input type="checkbox" class="system-checkbox" ${entry && entry.hidden ? 'checked' : ''} data-list="${kind}" data-index="${index}" data-prop="hidden">${tt('Hidden at first')}
                </label>
                ${kind === 'objectives' ? `<button type="button" class="rr-btn-secondary quest-pick" data-pick="switch" data-target="objectives.${index}.switchId" style="font-size:11px;" title="${rrEscapeHtml(tt('Completes on its own when this switch turns ON.'))}">${rrEscapeHtml(entry && entry.switchId > 0 ? this.switchName(entry.switchId) : tt('Switch…'))}</button>` : '<span></span>'}
                <span style="display:flex;gap:2px;">
                    <button type="button" class="rr-btn-secondary quest-move" data-list="${kind}" data-index="${index}" data-dir="-1" title="${rrEscapeHtml(tt('Move up'))}">▲</button>
                    <button type="button" class="rr-btn-secondary quest-move" data-list="${kind}" data-index="${index}" data-dir="1" title="${rrEscapeHtml(tt('Move down'))}">▼</button>
                </span>
                <button type="button" class="rr-btn-secondary quest-remove" data-list="${kind}" data-index="${index}" title="${rrEscapeHtml(tt('Remove'))}">✕</button>
            </div>`).join('');
        section.innerHTML = `
            <div class="database-section-header" style="display:flex;align-items:center;gap:8px;"><span style="flex:1;">${title}</span>
                <button type="button" class="rr-btn-secondary quest-add" data-list="${kind}">${addLabel}</button></div>
            <div class="database-section-content"><div class="quest-list" style="display:flex;flex-direction:column;gap:6px;padding:4px 0;">${rows || `<div style="color:var(--color-text-muted);font-size:12px;">${kind === 'objectives' ? tt('No objectives yet. A quest with none completes only by event command.') : tt('No rewards listed.')}</div>`}</div></div>`;
        return section;
    }

    attachListeners(container, quest) {
        const rerender = () => this.showQuestDetail(container, this.databaseManager.getQuest(quest.id) || quest);
        container.querySelectorAll('[data-field][data-quest-id]').forEach(field => {
            field.addEventListener('change', event => {
                const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
                this.updateQuestField(quest.id, event.target.dataset.field, value);
                if (event.target.dataset.field === 'activation.type' || event.target.dataset.field === 'completion.type') rerender();
                if (event.target.dataset.field === 'name') this.parentEditor.refreshDatabaseListEntry?.(quest, 'quests');
            });
        });
        container.querySelectorAll('[data-quest-setting]').forEach(field => {
            field.addEventListener('change', event => {
                const settings = this.settings();
                const key = event.target.dataset.questSetting;
                settings[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
                if (key === 'commandName' && !settings.commandName.trim()) settings.commandName = 'Quests';
                this.databaseManager.mutationGeneration++;
            });
        });
        container.querySelectorAll('[data-list][data-prop]').forEach(field => {
            field.addEventListener('change', event => {
                const { list, index, prop } = event.target.dataset;
                const entries = quest[list] || [];
                const entry = entries[Number(index)];
                if (!entry) return;
                entry[prop] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
                this.databaseManager.updateQuest(quest.id, quest);
            });
        });
        container.querySelectorAll('.quest-add').forEach(button => button.addEventListener('click', () => {
            const kind = button.dataset.list;
            quest[kind] = quest[kind] || [];
            quest[kind].push(kind === 'objectives' ? { text: '', hidden: false, switchId: 0 } : { text: '', hidden: false });
            this.databaseManager.updateQuest(quest.id, quest);
            rerender();
            const last = container.querySelector(`[data-list="${kind}"][data-prop="text"][data-index="${quest[kind].length - 1}"]`);
            if (last) last.focus();
        }));
        container.querySelectorAll('.quest-remove').forEach(button => button.addEventListener('click', () => {
            const { list, index } = button.dataset;
            (quest[list] || []).splice(Number(index), 1);
            this.databaseManager.updateQuest(quest.id, quest);
            rerender();
        }));
        container.querySelectorAll('.quest-move').forEach(button => button.addEventListener('click', () => {
            const { list, index, dir } = button.dataset;
            const entries = quest[list] || [];
            const from = Number(index);
            const to = from + Number(dir);
            if (to < 0 || to >= entries.length) return;
            [entries[from], entries[to]] = [entries[to], entries[from]];
            this.databaseManager.updateQuest(quest.id, quest);
            rerender();
        }));
        container.querySelectorAll('.quest-pick').forEach(button => button.addEventListener('click', () => {
            const kind = button.dataset.pick;
            const target = button.dataset.target;
            const current = this.readPath(quest, target);
            this.pickSwitchOrVariable(kind, current, id => {
                this.writePath(quest, target, id);
                this.databaseManager.updateQuest(quest.id, quest);
                button.textContent = kind === 'switch' ? this.switchName(id) : this.variableName(id);
                if (target.startsWith('objectives.') && !(id > 0)) button.textContent = this._t('Switch…');
            });
        }));
        const icon = container.querySelector('.quest-icon');
        if (icon) icon.addEventListener('click', () => {
            if (!this.parentEditor || !this.parentEditor.showIconPicker) return;
            this.parentEditor.showIconPicker(quest.iconIndex || 0, index => {
                quest.iconIndex = index;
                this.databaseManager.updateQuest(quest.id, quest);
                icon.innerHTML = this.iconHtml(index);
                this.parentEditor.refreshDatabaseListEntry?.(quest, 'quests');
            });
        });
        const importButton = container.querySelector('.quest-import');
        if (importButton) importButton.addEventListener('click', () => this.importFromVisustella());
    }

    readPath(object, path) {
        return path.split('.').reduce((value, part) => (value == null ? undefined : value[part]), object);
    }

    writePath(object, path, value) {
        const parts = path.split('.');
        let target = object;
        for (const part of parts.slice(0, -1)) {
            if (target[part] == null) target[part] = /^\d+$/.test(part) ? [] : {};
            target = target[part];
        }
        target[parts[parts.length - 1]] = value;
    }

    pickSwitchOrVariable(kind, current, callback) {
        if (typeof SwitchVariablePicker === 'undefined') {
            const typed = window.prompt(this._t(kind === 'switch' ? 'Switch number (0 for none)' : 'Variable number (0 for none)'), String(current || 0));
            if (typed !== null) callback(Math.max(0, parseInt(typed, 10) || 0));
            return;
        }
        if (!this._pickers) this._pickers = new SwitchVariablePicker(this.databaseManager, this.projectManager);
        this._pickers.show(kind, current || 1, id => callback(Number(id) || 0));
    }

    updateQuestField(questId, fieldName, value) {
        const quest = this.databaseManager.getQuest(questId);
        if (!quest) return;
        DatabaseQuestEditor.normalize(quest);
        if (fieldName === 'activation.value') value = parseInt(value, 10) || 0;
        if (fieldName === 'key') value = String(value || '').trim();
        this.writePath(quest, fieldName, value);
        this.databaseManager.updateQuest(questId, quest);
        return this.readPath(quest, fieldName);
    }

    /** Read the project's VisuStella quests and add the ones this database lacks. */
    importFromVisustella() {
        const project = this._project();
        if (!project || !project.path || typeof QuestImporter === 'undefined') return;
        const found = QuestImporter.readVisustella(project.path);
        const say = message => window.alert ? window.alert(message) : console.log(message);
        if (!found) return say(this._t('VisuStella Quest System is not in this project\'s plugin list.'));
        if (!found.quests.length) return say(this._t('The VisuStella plugin is installed but has no quests to import.'));
        const existing = this.databaseManager.getQuests();
        const taken = new Set(existing.map(quest => quest && quest.key).filter(Boolean));
        const fresh = found.quests.filter(quest => !quest.key || !taken.has(quest.key));
        if (!fresh.length) return say(this._t('Every VisuStella quest is already here (matched by key).'));
        const skipped = found.quests.length - fresh.length;
        const question = this._t('Import {count} quest(s) from VisuStella?', { count: fresh.length })
            + (skipped ? ' ' + this._t('{count} already here will be left alone.', { count: skipped }) : '');
        if (!window.confirm(question)) return;
        let last = null;
        for (const record of fresh) {
            record.key = QuestImporter.uniqueKey(record.key || record.name, taken);
            taken.add(record.key);
            last = this.databaseManager.addQuest(record);
        }
        if (this.parentEditor && this.parentEditor.openDatabase) {
            this.parentEditor.openDatabase('quests');
            if (last && this.parentEditor.showDatabaseDetail) this.parentEditor.showDatabaseDetail(last, 'quests');
        }
    }
}

if (typeof globalThis !== 'undefined') globalThis.DatabaseQuestEditor = DatabaseQuestEditor;
if (typeof module !== 'undefined' && module.exports) module.exports = DatabaseQuestEditor;
