/**
 * QuestImporter - reads another quest system's data into Reactor quests.
 *
 * Most quest systems are the same shape: a title, who gives it and where, a
 * description, objectives and rewards that can start hidden. VisuStella's
 * Quest System stores its quests four JSON layers deep inside one plugin
 * parameter; this reads that layer by layer and hands back plain Reactor
 * records, keys intact, so an event that named a quest by key keeps naming
 * it. Nothing is written here: the Quests tab decides what to keep.
 */
class QuestImporter {
    /** The plugin names an importer knows, by source id. */
    static SOURCES = {
        visustella: { plugin: 'VisuMZ_2_QuestSystem', label: 'VisuStella Quest System' }
    };

    /** The project's plugin manifest, as the runtime resolves it. */
    static manifestPath(projectPath) {
        const fs = require('fs');
        const path = require('path');
        const reactor = path.join(projectPath, 'js', 'reactor_plugins.js');
        if (fs.existsSync(path.join(projectPath, 'js', 'reactor_main.js')) && fs.existsSync(reactor)) return reactor;
        return path.join(projectPath, 'js', 'plugins.js');
    }

    /** The `$plugins` array of a manifest file, or [] when it cannot be read. */
    static readManifest(projectPath) {
        const fs = require('fs');
        try {
            const text = fs.readFileSync(QuestImporter.manifestPath(projectPath), 'utf8');
            return QuestImporter.parseManifest(text);
        } catch (error) {
            return [];
        }
    }

    static parseManifest(text) {
        const match = String(text || '').match(/\$plugins\s*=\s*(\[[\s\S]*\]);?\s*$/);
        if (!match) return [];
        try {
            const list = JSON.parse(match[1]);
            return Array.isArray(list) ? list : [];
        } catch (error) {
            return [];
        }
    }

    /** The VisuStella plugin's entry in a manifest, if any. */
    static visustellaEntry(plugins) {
        return (plugins || []).find(plugin => plugin && plugin.name === QuestImporter.SOURCES.visustella.plugin) || null;
    }

    /** One JSON layer: a string holding JSON becomes its value; anything else passes through. */
    static layer(value) {
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch (error) { return value; }
    }

    /** A note[] entry: the plugin stores each as a JSON string of the text. */
    static noteList(value) {
        const list = QuestImporter.layer(value);
        if (!Array.isArray(list)) return [];
        return list.map(entry => {
            const text = QuestImporter.layer(entry);
            return typeof text === 'string' ? text : String(entry == null ? '' : entry);
        });
    }

    /** number[] entries arrive as strings; 1-based in the plugin. */
    static numberList(value) {
        const list = QuestImporter.layer(value);
        if (!Array.isArray(list)) return [];
        return list.map(Number).filter(n => Number.isFinite(n));
    }

    /** A struct's field by its declared name, with or without the `:type` suffix. */
    static field(struct, name) {
        if (!struct || typeof struct !== 'object') return undefined;
        const key = Object.keys(struct).find(k => k === name || k.split(':')[0] === name);
        return key === undefined ? undefined : struct[key];
    }

    /** Text-code-free text for names and categories, keeping icons as codes. */
    static clean(text) {
        return String(text == null ? '' : text).replace(/\\\\/g, '\\').trim();
    }

    /**
     * The quests of a VisuStella `Categories` parameter value (the raw
     * string from the manifest, or an already-parsed array), as Reactor
     * records without ids. Order is the plugin's: category by category.
     */
    static fromVisustellaCategories(value) {
        const categories = QuestImporter.layer(value);
        const quests = [];
        if (!Array.isArray(categories)) return quests;
        for (const rawCategory of categories) {
            const category = QuestImporter.layer(rawCategory);
            const categoryName = QuestImporter.clean(QuestImporter.field(category, 'CategoryName'));
            const list = QuestImporter.layer(QuestImporter.field(category, 'Quests'));
            if (!Array.isArray(list)) continue;
            for (const rawQuest of list) {
                const quest = QuestImporter.layer(rawQuest);
                if (!quest || typeof quest !== 'object') continue;
                quests.push(QuestImporter.fromVisustellaQuest(quest, categoryName));
            }
        }
        return quests;
    }

    static fromVisustellaQuest(struct, categoryName) {
        const descriptions = QuestImporter.noteList(QuestImporter.field(struct, 'Description'));
        const objectiveTexts = QuestImporter.noteList(QuestImporter.field(struct, 'Objectives'));
        const visibleObjectives = QuestImporter.numberList(QuestImporter.field(struct, 'VisibleObjectives'));
        const rewardTexts = QuestImporter.noteList(QuestImporter.field(struct, 'Rewards'));
        const visibleRewards = QuestImporter.numberList(QuestImporter.field(struct, 'VisibleRewards'));
        const subtexts = QuestImporter.noteList(QuestImporter.field(struct, 'Subtext'));
        const quotes = QuestImporter.noteList(QuestImporter.field(struct, 'Quotes'));
        const title = QuestImporter.clean(QuestImporter.field(struct, 'Title'));
        const key = QuestImporter.clean(QuestImporter.field(struct, 'Key'));
        const noteLines = [];
        // VisuStella keeps several descriptions, subtexts and quotes per
        // quest and switches between them by plugin command. Reactor shows
        // one of each; the rest are kept in the note so nothing is lost.
        if (descriptions.length > 1) noteLines.push('<Import: other descriptions>', ...descriptions.slice(1), '</Import>');
        if (subtexts.filter(Boolean).length > 1) noteLines.push('<Import: other subtexts>', ...subtexts.slice(1), '</Import>');
        if (quotes.filter(Boolean).length > 1) noteLines.push('<Import: other quotes>', ...quotes.slice(1), '</Import>');
        const onLoad = QuestImporter.layer(QuestImporter.field(struct, 'OnLoadQuestJS'));
        if (typeof onLoad === 'string' && onLoad.trim() && !/^\/\/ Insert JavaScript code here\.?$/.test(onLoad.trim())) {
            noteLines.push('<Import: on-load script>', onLoad, '</Import>');
        }
        return {
            name: title || key || 'Quest',
            key: key || '',
            category: categoryName,
            iconIndex: 0,
            difficulty: QuestImporter.clean(QuestImporter.field(struct, 'Difficulty')),
            from: QuestImporter.clean(QuestImporter.field(struct, 'From')),
            location: QuestImporter.clean(QuestImporter.field(struct, 'Location')),
            description: QuestImporter.clean(descriptions[0] || ''),
            objectives: objectiveTexts.map((text, index) => ({
                text: QuestImporter.clean(text), hidden: !visibleObjectives.includes(index + 1), switchId: 0
            })),
            rewards: rewardTexts.map((text, index) => ({
                text: QuestImporter.clean(text), hidden: !visibleRewards.includes(index + 1)
            })),
            subtext: QuestImporter.clean(subtexts.find(Boolean) || ''),
            quotes: QuestImporter.clean(quotes.find(Boolean) || ''),
            activation: { type: 'command', switchId: 0, variableId: 0, operator: '>=', value: 0 },
            completion: { type: 'command', switchId: 0 },
            note: noteLines.join('\n')
        };
    }

    /**
     * Everything importable from a project's VisuStella plugin: the quest
     * records and where they came from, or `null` when the plugin is not in
     * the manifest at all.
     */
    static readVisustella(projectPath) {
        const plugins = QuestImporter.readManifest(projectPath);
        const entry = QuestImporter.visustellaEntry(plugins);
        if (!entry) return null;
        const params = entry.parameters || {};
        const raw = params['Categories:arraystruct'] !== undefined ? params['Categories:arraystruct'] : params.Categories;
        return {
            source: 'visustella',
            enabled: entry.status !== false,
            quests: QuestImporter.fromVisustellaCategories(raw)
        };
    }

    /** A key nobody else has: the wanted one, or it with a number after it. */
    static uniqueKey(wanted, taken) {
        const base = String(wanted || '').trim() || 'quest';
        if (!taken.has(base)) return base;
        let n = 2;
        while (taken.has(`${base}${n}`)) n++;
        return `${base}${n}`;
    }
}

if (typeof globalThis !== 'undefined') globalThis.QuestImporter = QuestImporter;
if (typeof module !== 'undefined' && module.exports) module.exports = QuestImporter;
