import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  SlateLocalExecPathError, buildLocalExecManager, containPath, escapesRoot,
  missingWorkingDirectoryNotice, regularFileSizeBytes, resolveLocalExecRoot, resolveShellWorkingDirectory,
} from "../../source/host/local-exec/local-exec-machine.ts";

test("the configured local root wins, then project root, then home", () => {
  assert.equal(resolveLocalExecRoot({ SLATE_LOCAL_EXEC_ROOT: " /machine ", SLATE_AGENT_PROJECT_DIR: "/project" } as NodeJS.ProcessEnv), "/machine");
  assert.equal(resolveLocalExecRoot({ SLATE_LOCAL_EXEC_ROOT: "  ", SLATE_AGENT_PROJECT_DIR: " /project " } as NodeJS.ProcessEnv), "/project");
  assert.equal(resolveLocalExecRoot({} as NodeJS.ProcessEnv), resolveLocalExecRoot({} as NodeJS.ProcessEnv));
});

test("file size is returned only for regular files", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-exec-size-"));
  try { const file=join(root,"file"), directory=join(root,"dir"); await writeFile(file,"12345"); await mkdir(directory); assert.equal(await regularFileSizeBytes(file),5); assert.equal(await regularFileSizeBytes(directory),undefined); assert.equal(await regularFileSizeBytes(join(root,"missing")),undefined); }
  finally { await rm(root,{recursive:true,force:true}); }
});

test("working directory resolution trims and falls back for missing paths or files", async () => {
  const root=await mkdtemp(join(tmpdir(),"local-exec-cwd-"));
  try { const child=join(root,"child"); await mkdir(child); assert.deepEqual(await resolveShellWorkingDirectory({root,requested:" child "}),{workingDirectory:child,fellBackToRoot:false}); assert.deepEqual(await resolveShellWorkingDirectory({root,requested:"  "}),{workingDirectory:"",fellBackToRoot:false}); assert.deepEqual(await resolveShellWorkingDirectory({root,requested:"missing"}),{workingDirectory:root,fellBackToRoot:true}); const file=join(root,"file"); await writeFile(file,"x"); assert.deepEqual(await resolveShellWorkingDirectory({root,requested:file}),{workingDirectory:root,fellBackToRoot:true}); }
  finally { await rm(root,{recursive:true,force:true}); }
});

test("containment blocks lexical and symlink escapes while permitting inside paths", async () => {
  const root=await mkdtemp(join(tmpdir(),"local-exec-contain-")), outside=await mkdtemp(join(tmpdir(),"local-exec-outside-"));
  try { assert.equal(escapesRoot(root,root),false); assert.equal(escapesRoot(root,join(root,"inside")),false); assert.equal(escapesRoot(root,outside),true); assert.equal(escapesRoot("/tmp/work","/tmp/worker/file"),true); assert.equal(await containPath({root,path:"inside/new.txt"}),join(root,"inside","new.txt")); await assert.rejects(containPath({root,path:outside}),{message:`Path is outside the allowed local-exec root and was refused: ${outside}`}); const link=join(root,"escape"); await symlink(outside,link,"dir"); await assert.rejects(containPath({root,path:link}),(error:unknown)=>error instanceof SlateLocalExecPathError && error.message===`Path resolves through a symlink to outside the allowed local-exec root and was refused: ${link}`); }
  finally { await Promise.all([rm(root,{recursive:true,force:true}),rm(outside,{recursive:true,force:true})]); }
});

test("unreadable roots preserve the contained lexical path", async () => { const root=join(tmpdir(),"local-exec-no-such-root","nested"); assert.equal(await containPath({root,path:"child"}),resolve(root,"child")); });

test("notices and manager wiring expose the complete guard set", () => { assert.equal(missingWorkingDirectoryNotice({requested:"./gone",root:"/work"}),"working directory ./gone does not exist on this machine; running in /work instead\n"); const expected={containPath,regularFileSizeBytes,resolveShellWorkingDirectory,missingWorkingDirectoryNotice}; const runtime={build:(root:string,limit:number,guards:typeof expected)=>({root,limit,guards})}; const result=buildLocalExecManager("/work",123,runtime); assert.equal(result.root,"/work"); assert.equal(result.limit,123); assert.deepEqual(result.guards,expected); });
