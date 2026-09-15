import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(project, '../..');
const records = [];
const write = (name, text) => { const dest = path.join(project, name); fs.mkdirSync(path.dirname(dest), {recursive:true}); fs.writeFileSync(dest, text); };
const source = (name) => {
  const text = fs.readFileSync(path.join(repo, name), 'utf8');
  records.push({path:name, sha256:crypto.createHash('sha256').update(text).digest('hex')});
  return text;
};
function extract(file, symbols) {
  const text = source(file);
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return symbols.map(name => {
    const stmt = ast.statements.find(n => n.name?.text === name || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === name));
    if (!stmt) throw new Error(`Missing ${file}:${name}`);
    const value = stmt.getText(ast);
    write(`provenance/original/${name}.tsx.txt`, value);
    return value;
  });
}

const [message, content] = extract('components/ai-elements/message.tsx', ['Message','MessageContent']);
const [taskItem, taskFile] = extract('components/ai-elements/task.tsx', ['TaskItem','TaskItemFile']);
const [artifact, artifactHeader, artifactTitle, artifactContent] = extract('components/ai-elements/artifact.tsx', ['Artifact','ArtifactHeader','ArtifactTitle','ArtifactContent']);
const [editOriginal, changeOriginal] = extract('components/chat-timeline.tsx', ['EditableUserMessage','ChangeItem']);

let editor = editOriginal.slice(editOriginal.indexOf('  return <div'));
editor = editor.replaceAll('autoFocus ', '').replaceAll('从此处重新生成后续对话，不回滚文件修改。','Regenerates the conversation from here. File changes are not rolled back.').replaceAll('正在重发…','Resending…').replaceAll('重发','Resend').replaceAll('取消','Cancel').replaceAll('编辑原消息','Edit original message').replaceAll('消息内容','Message content').replaceAll('编辑消息：','Edit message:');
const editorHeader = `export function EditableUserMessage({item, editing=false, draft=item.text, pending=false}: {item: {id:string;text:string};editing?:boolean;draft?:string;pending?:boolean}) {
const disabled=false, error: string|null=null;
const onEditMessage=true;
const trigger=React.useRef<HTMLButtonElement>(null);
const submit=()=>{}, cancel=()=>{}, setDraft=(_s:string)=>{}, setError=(_s:null)=>{}, setEditing=(_b:boolean)=>{};
`;
let change = changeOriginal.replace('function ChangeItem({ item }: { item: Extract<TimelineItem, { kind: \'change\' }> }) {', `export function ChangeItem({ item, open=false, selectedPath }: {item: ChangeData;open?:boolean;selectedPath?:string}) {`)
  .replace('  const [open, setOpen] = useState(false)', '  const setOpen = (_update: (value: boolean) => boolean) => {}')
  .replace('  const [selectedPath, setSelectedPath] = useState<string | undefined>()', '  const setSelectedPath = (_path: string) => {}')
  .replace('.filter((file) => !isLegacyRuntimeSnapshotPath(file.path))','')
  .replaceAll('查看差异','View diff').replaceAll('收起 Git 变更','Collapse Git changes').replaceAll('展开 Git 变更','Expand Git changes');
write('src/source-ui.tsx', `// GENERATED from real OpenLink source. See provenance/manifest.json and scripts/extract-source.mjs.
import * as React from 'react';
import type {HTMLAttributes, ComponentProps} from 'react';
import {clsx, type ClassValue} from 'clsx';
import {twMerge} from 'tailwind-merge';
import {Atom, ChevronDown, ChevronRight, RotateCcw} from 'lucide-react';
const cn=(...v:ClassValue[])=>twMerge(clsx(v));
type MessageProps=HTMLAttributes<HTMLDivElement>&{from:'user'|'assistant'};
type MessageContentProps=HTMLAttributes<HTMLDivElement>;
type TaskItemProps=ComponentProps<'div'>;
type TaskItemFileProps=ComponentProps<'div'>;
type ArtifactProps=HTMLAttributes<HTMLDivElement>;
type ArtifactHeaderProps=HTMLAttributes<HTMLDivElement>;
type ArtifactTitleProps=HTMLAttributes<HTMLParagraphElement>;
type ArtifactContentProps=HTMLAttributes<HTMLDivElement>;
type FileChange={path:string;additions?:number;deletions?:number;patch?:string};
export type ChangeData={label:string;files?:FileChange[];snapshot?:boolean;additions?:number;deletions?:number;baseCommit?:string;changeCount?:number};
${[message, content, taskItem, taskFile, artifact, artifactHeader, artifactTitle, artifactContent, editorHeader+editor, change].join('\n\n')}
`);

// Preserve the application theme exactly, while containing scanning to this video.
const css = source('app/globals.css').replace(/^@import .*;\n/gm,'').replace(/^@source .*;\n/gm,'');
write('src/app-theme.css', css);
for (const name of ['zorker-dark.svg','zorker-light.svg','zorker-logo-dark.svg','zorker-logo-light.svg']) {
  write(`public/brand/${name}`, source(`public/openlink/logos/${name}`));
}
write('provenance/manifest.json', JSON.stringify({repository:'OpenLink', baseCommit:'25214c809079b54cd8c61dae79fa14f080c90a8b', capturedAt:'2026-09-07', records, adaptations:['Selected pure exports copied without JSX/style changes.','EditableUserMessage and ChangeItem retain source JSX and class names; local state becomes frame props, callbacks inert, labels translated to English.','Legacy file filtering omitted because fixtures contain only safe paths.','Composer visible layout is a presentation-only port of workspace-prompt.tsx; no server actions or model menu.','Browser/code shell is a presentation-only adaptation of chat-workspace.tsx; preview is a fictional website fixture, not a live provider result.','Source CSS retained, CSS animations/transitions disabled by video override.','Source snapshots include existing user modifications; no app business logic changed.'], rights:'User-supplied project and brand assets, for requested demo. No third-party media. Component dependency licenses remain applicable; public distribution rights not independently audited.'}, null, 2));
console.log('Extracted source UI, theme and brand with SHA-256 provenance.');
