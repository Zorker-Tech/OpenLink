// GENERATED from real OpenLink source. See provenance/manifest.json and scripts/extract-source.mjs.
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
export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export const TaskItem = ({ children, className, ...props }: TaskItemProps) => (
  <div className={cn("text-muted-foreground text-sm", className)} {...props}>
    {children}
  </div>
);

export const TaskItemFile = ({
  children,
  className,
  ...props
}: TaskItemFileProps) => (
  <div
    className={cn(
      "inline-flex items-center gap-1 rounded-md border bg-secondary px-1.5 py-0.5 text-foreground text-xs",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export const Artifact = ({ className, ...props }: ArtifactProps) => (
  <div
    className={cn(
      "flex flex-col overflow-hidden rounded-lg border bg-background shadow-sm",
      className
    )}
    {...props}
  />
);

export const ArtifactHeader = ({
  className,
  ...props
}: ArtifactHeaderProps) => (
  <div
    className={cn(
      "flex items-center justify-between border-b bg-muted/50 px-4 py-3",
      className
    )}
    {...props}
  />
);

export const ArtifactTitle = ({ className, ...props }: ArtifactTitleProps) => (
  <p
    className={cn("font-medium text-foreground text-sm", className)}
    {...props}
  />
);

export const ArtifactContent = ({
  className,
  ...props
}: ArtifactContentProps) => (
  <div className={cn("flex-1 overflow-auto p-4", className)} {...props} />
);

export function EditableUserMessage({item, editing=false, draft=item.text, pending=false}: {item: {id:string;text:string};editing?:boolean;draft?:string;pending?:boolean}) {
const disabled=false, error: string|null=null;
const onEditMessage=true;
const trigger=React.useRef<HTMLButtonElement>(null);
const submit=()=>{}, cancel=()=>{}, setDraft=(_s:string)=>{}, setError=(_s:null)=>{}, setEditing=(_b:boolean)=>{};
  return <div className="relative flex w-full justify-end" data-message-id={item.id}>
    {editing && <div aria-hidden="true" className="invisible mb-4 max-w-[95%] whitespace-pre-wrap break-words rounded-xl border px-3 py-1.5 text-[13px] leading-[21.125px]">{item.text}</div>}
    {editing ? <form
      aria-label="Edit original message"
      className="absolute left-1/2 top-0 z-20 mx-auto flex w-[95%] min-w-0 -translate-x-1/2 flex-col gap-3 rounded-xl border border-dashed border-[var(--app-muted)] bg-[var(--app-elevated)] p-3 shadow-[0_12px_36px_var(--app-shadow)]"
      onSubmit={(event) => { event.preventDefault(); void submit() }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape' && !pending) { event.preventDefault(); cancel() }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit() }
      }}
    >
      <textarea aria-label="Message content" className="min-h-20 max-h-64 w-full resize-y bg-transparent text-[13px] leading-[21px] text-[var(--app-foreground)] outline-none" value={draft} maxLength={10000} disabled={pending} onChange={(event) => setDraft(event.target.value)} />
      <p className="text-[11px] leading-4 text-[var(--app-muted)]">Regenerates the conversation from here. File changes are not rolled back.</p>
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md px-3 py-1.5 text-xs hover:bg-[var(--app-hover)] focus-visible:outline" disabled={pending} onClick={cancel}>Cancel</button>
        <button type="submit" className="rounded-md bg-[var(--app-submit-background)] px-3 py-1.5 text-xs text-[var(--app-submit-foreground)] disabled:opacity-40 focus-visible:outline" disabled={pending || disabled || !draft.trim()}>{pending ? 'Resending…' : 'Resend'}</button>
      </div>
    </form> : <button ref={trigger} type="button" aria-label={`Edit message:${item.text}`} disabled={disabled || !onEditMessage}
      className="mb-4 max-w-[95%] whitespace-pre-wrap break-words rounded-xl border border-[var(--app-control-border)] bg-[var(--app-active)] px-3 py-1.5 text-left text-[13px] leading-[21.125px] text-[var(--app-foreground)] outline-none hover:border-[var(--app-muted)] focus-visible:ring-1 focus-visible:ring-[var(--app-muted)]"
      onClick={() => { setDraft(item.text); setError(null); setEditing(true) }}
    >{item.text}</button>}
  </div>
}

export function ChangeItem({ item, open=false, selectedPath }: {item: ChangeData;open?:boolean;selectedPath?:string}) {
  const setOpen = (_update: (value: boolean) => boolean) => {}
  const setSelectedPath = (_path: string) => {}
  // Old persisted snapshots may predate the Worker-level exclusion policy.
  // Filter them at render time as a migration guard; all new snapshots are
  // already clean at collection time.
  const files = (item.files ?? []).map((file) => typeof file === 'string' ? { path: file } : file)
  const selected = files.find((file) => file.path === selectedPath) ?? files[0]
  const additions = item.snapshot ? files.reduce((total, file) => total + (file.additions ?? 0), 0) : item.additions
  const deletions = item.snapshot ? files.reduce((total, file) => total + (file.deletions ?? 0), 0) : item.deletions

  if (item.snapshot && files.length === 0) return null

  return (
    <div className={`overflow-hidden rounded-lg border border-[color-mix(in_oklab,var(--app-foreground)_16%,var(--app-border))] bg-[var(--app-elevated)] p-2 shadow-[0_6px_20px_var(--app-shadow)] transition-[max-height,border-color] duration-200 ease-out ${open ? 'max-h-[540px] border-[color-mix(in_oklab,var(--app-foreground)_24%,var(--app-border))]' : 'max-h-[46px]'}`} data-slot="git-snapshot">
      <div className="flex h-7 items-center gap-1">
        <button aria-expanded={open} className="flex h-7 min-w-0 flex-1 select-none items-center gap-2 rounded-md text-left outline-none hover:text-[var(--app-foreground)] focus:outline-none focus-visible:outline-none" onClick={() => setOpen((value) => !value)} type="button">
          {open ? <ChevronDown className="size-[13px] shrink-0 text-[var(--app-muted)]" /> : <ChevronRight className="size-[13px] shrink-0 text-[var(--app-muted)]" />}
          <span className="min-w-0 truncate text-[13px] font-medium tracking-[-0.0762px] text-[var(--app-foreground)]">{item.label}</span>
          {item.baseCommit ? <span className="shrink-0 font-mono text-[11px] text-[var(--app-muted)]">@{item.baseCommit}</span> : item.changeCount && item.changeCount > 1 ? <span className="shrink-0 text-[12px] text-[var(--app-muted)]">v{item.changeCount}</span> : null}
        </button>
        {(additions !== undefined || deletions !== undefined) && (
          <button aria-label="View diff" className="flex h-6 shrink-0 items-center rounded-md border border-[var(--app-control-border)] bg-[var(--app-active)] px-2 text-xs font-semibold hover:bg-[var(--app-hover)]" type="button">
            <span className="text-[var(--app-success)]">+{additions ?? 0}</span>
            <span className="px-0.5 text-[var(--app-muted)]">/</span>
            <span className="text-[var(--app-danger)]">-{deletions ?? 0}</span>
          </button>
        )}
        <button aria-label={open ? 'Collapse Git changes' : 'Expand Git changes'} className="flex size-6 items-center justify-center rounded text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" onClick={() => setOpen((value) => !value)} type="button"><RotateCcw className="size-3.5" /></button>
      </div>
      {open && files.length ? (
        <div className="max-h-[480px] overflow-y-auto pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="space-y-0.5">
          {files.map((change) => {
            const segments = change.path.split('/')
            const name = segments.at(-1) ?? change.path
            const directory = segments.slice(0, -1).join('/')
            return (
              <button aria-pressed={selected?.path === change.path} className={`flex h-7 w-full min-w-0 items-center gap-2 rounded px-0.5 text-left transition-colors hover:bg-[var(--app-hover)] ${selected?.path === change.path ? 'bg-[var(--app-active)]' : ''}`} key={change.path} onClick={() => setSelectedPath(change.path)} type="button">
                <Atom className="size-4 shrink-0 text-[var(--app-info)]" />
                <span className="shrink-0 text-[13px] text-[var(--app-foreground)]">{name}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--app-subtle-foreground)]">{directory}</span>
                {(change.additions !== undefined || change.deletions !== undefined) && (
                  <span className="flex shrink-0 items-center gap-0.5 text-[12px]">
                    <span className="text-[var(--app-success)]">+{change.additions ?? 0}</span>
                    {change.deletions ? <span className="text-[var(--app-danger)]">/-{change.deletions}</span> : null}
                  </span>
                )}
              </button>
            )
          })}
          </div>
          {selected?.patch ? (
            <pre className="mt-2 max-h-[248px] overflow-auto rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] p-2 font-mono text-[11px] leading-4 text-[var(--app-foreground)]"><code className="whitespace-pre-wrap break-words">{selected.patch}</code></pre>
          ) : item.snapshot ? <p className="mt-2 text-[12px] text-[var(--app-muted)]">Git detected this file, but it has no text diff to preview.</p> : null}
        </div>
      ) : null}
    </div>
  )
}
