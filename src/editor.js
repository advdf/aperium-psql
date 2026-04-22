import { EditorView, keymap, placeholder } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { autocompletion, acceptCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Catppuccin Mocha theme
const catppuccinTheme = EditorView.theme({
  '&': {
    backgroundColor: '#1e1e2e',
    color: '#cdd6f4',
    fontSize: '13px',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', monospace",
    height: '100%',
  },
  '.cm-content': {
    caretColor: '#f5e0dc',
    padding: '8px 0',
    lineHeight: '1.5',
  },
  '.cm-cursor': {
    borderLeftColor: '#f5e0dc',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: '#585b7066 !important',
  },
  '.cm-gutters': {
    backgroundColor: '#181825',
    color: '#6c7086',
    border: 'none',
    borderRight: '1px solid #313244',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#1e1e2e',
    color: '#cdd6f4',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(88, 91, 112, 0.15)',
  },
  '.cm-tooltip': {
    backgroundColor: '#181825',
    border: '1px solid #313244',
    borderRadius: '6px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  },
  '.cm-tooltip-autocomplete': {
    '& > ul': {
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', monospace",
      fontSize: '12px',
    },
    '& > ul > li': {
      padding: '4px 8px',
      color: '#cdd6f4',
    },
    '& > ul > li[aria-selected]': {
      backgroundColor: '#313244',
      color: '#cdd6f4',
    },
  },
  '.cm-completionLabel': {
    color: '#cdd6f4',
  },
  '.cm-completionMatchedText': {
    color: '#89b4fa',
    textDecoration: 'none',
    fontWeight: '600',
  },
  '.cm-completionDetail': {
    color: '#6c7086',
    fontStyle: 'italic',
    marginLeft: '8px',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
}, { dark: true });

const catppuccinHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#cba6f7', fontWeight: '600' },
  { tag: tags.operator, color: '#94e2d5' },
  { tag: tags.string, color: '#a6e3a1' },
  { tag: tags.number, color: '#fab387' },
  { tag: tags.bool, color: '#fab387' },
  { tag: tags.null, color: '#f38ba8', fontStyle: 'italic' },
  { tag: tags.comment, color: '#6c7086', fontStyle: 'italic' },
  { tag: tags.typeName, color: '#89b4fa' },
  { tag: tags.function(tags.variableName), color: '#89b4fa' },
  { tag: tags.propertyName, color: '#f9e2af' },
  { tag: tags.punctuation, color: '#9399b2' },
  { tag: tags.paren, color: '#9399b2' },
  { tag: tags.squareBracket, color: '#9399b2' },
  { tag: tags.brace, color: '#9399b2' },
  { tag: tags.definitionKeyword, color: '#cba6f7', fontWeight: '600' },
  { tag: tags.standard(tags.name), color: '#f9e2af' },
]);

// Schema state — will be updated with real table/column info
let schemaState = {};

export function updateSchema(schema) {
  schemaState = schema;
}

export function createEditor(parent, { onRun, onSendTerminal, onHistoryPrev, onHistoryNext }) {
  const runKeymap = keymap.of([
    {
      key: 'Mod-Enter',
      run: () => { onRun(); return true; },
    },
    {
      key: 'Mod-Shift-Enter',
      run: () => { onSendTerminal(); return true; },
    },
    {
      key: 'Tab',
      run: acceptCompletion,
    },
    {
      key: 'Mod-ArrowUp',
      run: () => { if (onHistoryPrev) onHistoryPrev(); return true; },
    },
    {
      key: 'Mod-ArrowDown',
      run: () => { if (onHistoryNext) onHistoryNext(); return true; },
    },
  ]);

  const state = EditorState.create({
    doc: '',
    extensions: [
      Prec.highest(runKeymap),
      keymap.of([...defaultKeymap, indentWithTab, ...searchKeymap]),
      sql({
        dialect: PostgreSQL,
        upperCaseKeywords: true,
        schema: schemaState,
      }),
      autocompletion({
        activateOnTyping: true,
        maxRenderedOptions: 30,
      }),
      catppuccinTheme,
      syntaxHighlighting(catppuccinHighlight),
      placeholder('-- Write your SQL here. Cmd+Enter to run, Cmd+Shift+Enter to send to terminal.'),
      EditorView.lineWrapping,
    ],
  });

  const view = new EditorView({ state, parent });
  return view;
}
