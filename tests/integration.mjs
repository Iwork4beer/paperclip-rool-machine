import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const adapterPath = path.join(packageRoot, "adapter", "index.js");
const parserPath = path.join(packageRoot, "adapter", "ui-parser.js");
const bridgeSource = path.join(packageRoot, "bridge", "bridge.mjs");

const tmp = await mkdtemp(path.join(os.tmpdir(), "rool-adapter-test-"));
const fixture = path.join(tmp, "fixture");
await mkdir(fixture, { recursive: true });
await cp(bridgeSource, path.join(fixture, "bridge.mjs"));

const sdkRoot = path.join(fixture, "node_modules", "@rool-dev", "sdk");
await mkdir(sdkRoot, { recursive: true });
await writeFile(path.join(sdkRoot, "package.json"), JSON.stringify({
  name: "@rool-dev/sdk",
  version: "2.0.5-mock",
  type: "module",
  exports: { ".": "./index.js", "./node": "./node.js" },
}, null, 2));

const statePath = path.join(tmp, "mock-rool-state.json");
const driveRoot = path.join(tmp, "drive");
await mkdir(driveRoot, { recursive: true });
await writeFile(statePath, JSON.stringify({ conversations: {}, prompts: [] }));

await writeFile(path.join(sdkRoot, "node.js"), `
export class NodeAuth {
  constructor({credentialsPath}) { this.credentialsPath = credentialsPath; this.getTokens = async () => ({accessToken:"mock"}); this.logout = async () => {}; }
  async initialize() { return true; }
}
`);

await writeFile(path.join(sdkRoot, "index.js"), `
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const statePath = process.env.MOCK_ROOL_STATE;
const driveRoot = process.env.MOCK_ROOL_DRIVE;
async function load(){ return JSON.parse(await readFile(statePath,"utf8")); }
async function save(s){ await writeFile(statePath, JSON.stringify(s,null,2)); }
function textTurn(role,text){ return {role, content:[{text}]}; }
function convApi(id){
  return {
    async get(){ const s=await load(); return s.conversations[id] ?? null; },
    async prompt(prompt,opts={}){ const s=await load(); const c=s.conversations[id]; c.turns.push(textTurn("user",prompt)); c.turns.push(textTurn("assistant","MOCK COMPLETED RESULT")); c.isRunning=false; s.prompts.push({id,prompt,attachments:opts.attachments||[]}); await save(s); },
    async follow(){ const s=await load(); if(s.conversations[id]) s.conversations[id].isRunning=false; await save(s); }
  };
}
export class RoolClient {
  constructor(){}
  async getSession(){ return {machines:[{id:"machine-test-1"}]}; }
  machine(id){
    return {
      files:{ async write(remote,content){ const rel=remote.replace(/^\\/+/,""); const dest=path.join(driveRoot,rel); await mkdir(path.dirname(dest),{recursive:true}); await writeFile(dest,content); } },
      agents:{ async get(name){ if(name!=="rool") return null; return {
        conversation(id){ return convApi(id); },
        async createConversation({id}){ const s=await load(); s.conversations[id]={turns:[],isRunning:false}; await save(s); return convApi(id); }
      }; } }
    };
  }
}
`);

const instructionsRoot = path.join(tmp, "instructions");
await mkdir(instructionsRoot, { recursive: true });
await writeFile(path.join(instructionsRoot, "AGENTS.md"), "# Worker instructions\nRead TOOLS.md.\n");
await writeFile(path.join(instructionsRoot, "TOOLS.md"), "# Tools\nDo useful work.\n");
const skillRoot = path.join(tmp, "skill-paperclip");
await mkdir(skillRoot, { recursive: true });
await writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: paperclip\ndescription: Paperclip operating procedure\n---\n# Skill\n");
await writeFile(path.join(skillRoot, "helper.txt"), "helper\n");

const issue = {
  id: "task-1",
  identifier: "STA-99",
  title: "Integration test task",
  description: "Use the attachment and finish the job.",
  status: "todo",
  priority: "high",
  assigneeAgentId: "agent-1",
  project: { id: "project-1", name: "Test Project" },
  goal: { id: "goal-1", title: "Test Goal" },
  ancestors: [],
};
const calls = [];
const server = http.createServer(async (req,res) => {
  const chunks=[]; for await (const c of req) chunks.push(c); const body=Buffer.concat(chunks).toString();
  calls.push({method:req.method,url:req.url,body});
  const json=(status,obj)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(obj));};
  if(req.method==="GET" && req.url==="/api/issues/task-1") return json(200, issue);
  if(req.method==="POST" && req.url==="/api/issues/task-1/checkout") { issue.status="in_progress"; return json(200, issue); }
  if(req.method==="GET" && req.url==="/api/issues/task-1/heartbeat-context") return json(200,{summary:"heartbeat context",newComments:1});
  if(req.method==="GET" && req.url==="/api/issues/task-1/comments?order=asc") return json(200,[{id:"c1",body:"Important comment"}]);
  if(req.method==="GET" && req.url==="/api/issues/task-1/attachments") return json(200,[{id:"att-1",filename:"evidence.txt",mimeType:"text/plain"}]);
  if(req.method==="GET" && req.url==="/api/attachments/att-1/content") {res.writeHead(200,{"content-type":"text/plain"}); return res.end("ATTACHMENT EVIDENCE\n");}
  if(req.method==="GET" && req.url==="/api/agents/me") return json(200,{id:"agent-1",reportsTo:"manager-1"});
  if(req.method==="POST" && req.url==="/api/issues/task-1/interactions") return json(201,{id:"interaction-1"});
  if(req.method==="PATCH" && req.url==="/api/issues/task-1") return json(200,{...issue,status:"done"});
  if(req.method==="GET" && req.url==="/api/agents/me/inbox-lite") return json(200,[issue]);
  return json(404,{error:"not found",method:req.method,url:req.url});
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const {port}=server.address();
process.env.PAPERCLIP_API_URL=`http://127.0.0.1:${port}`;
process.env.MOCK_ROOL_STATE=statePath;
process.env.MOCK_ROOL_DRIVE=driveRoot;

const adapter = await import(pathToFileURL(adapterPath));
const parser = await import(pathToFileURL(parserPath));
const baseConfig = {
  machineId:"machine-test-1",
  label:"WORK1",
  profile:"default",
  bridgePath:path.join(fixture,"bridge.mjs"),
  cwd:fixture,
  instructionsBundleMode:"managed",
  instructionsRootPath:instructionsRoot,
  instructionsEntryFile:"AGENTS.md",
  instructionsFilePath:path.join(instructionsRoot,"AGENTS.md"),
  paperclipSkillSync:{desiredSkills:["paperclip"]},
  paperclipRuntimeSkills:[{key:"paperclip",runtimeName:"paperclip",source:skillRoot,sourceStatus:"available"}],
  env:{ROOL_CREDENTIALS_JSON:'{"mock":true}',MOCK_ROOL_STATE:statePath,MOCK_ROOL_DRIVE:driveRoot},
};

const module = adapter.createServerAdapter();
assert.equal(module.supportsInstructionsBundle,true);
assert.equal(module.instructionsPathKey,"instructionsFilePath");
assert.equal(module.requiresMaterializedRuntimeSkills,true);
assert.equal(typeof module.listSkills,"function");
assert.equal(typeof module.syncSkills,"function");
assert.equal(typeof module.sessionCodec?.serialize,"function");
const snapshot=await module.listSkills({adapterType:"rool_machine",config:baseConfig});
assert.equal(snapshot.supported,true);
assert.equal(snapshot.mode,"ephemeral");
assert.equal(snapshot.entries[0].state,"configured");

const envTest=await module.testEnvironment({adapterType:"rool_machine",config:baseConfig});
assert.notEqual(envTest.status,"fail",JSON.stringify(envTest,null,2));
assert(envTest.checks.some(c=>c.code==="rool_remote_probe_ok"));

const logs1=[];
const ctx1={
  runId:"run-1",
  authToken:"jwt-test",
  agent:{id:"agent-1",companyId:"company-1",name:"Test Worker",adapterConfig:baseConfig},
  runtime:{sessionId:null,sessionParams:null,sessionDisplayId:null,taskKey:"task-1"},
  config:baseConfig,
  context:{taskId:"task-1",wakeReason:"assignment"},
  onLog:async(stream,text)=>logs1.push({stream,text}),
  onMeta:async()=>{},
  onSpawn:async()=>{},
};
const r1=await module.execute(ctx1);
assert.equal(r1.exitCode,0,JSON.stringify(r1,null,2));
assert.equal(r1.provider,"rool");
assert(r1.sessionParams?.conversationId);
assert.equal(r1.sessionParams.taskId,"task-1");
assert.equal(r1.resultJson.transported.instructions.files,2);
assert.equal(r1.resultJson.transported.skills.count,1);
assert.equal(r1.resultJson.transported.attachments.count,1);

const state1=JSON.parse(await readFile(statePath,"utf8"));
assert.equal(state1.prompts.length,1);
assert(state1.prompts[0].prompt.includes("[PAPERCLIP-RUN:run-1]"));
assert(state1.prompts[0].attachments.some(p=>p.endsWith("TASK-CONTEXT.md")));
assert(state1.prompts[0].attachments.some(p=>p.endsWith("AGENTS.md")));
assert(state1.prompts[0].attachments.some(p=>p.includes("evidence.txt")));

const taskContextPath = path.join(driveRoot,"rool-drive","paperclip","STA-99","runs","run-1","TASK-CONTEXT.md");
const taskContext=await readFile(taskContextPath,"utf8");
assert(taskContext.includes("Important comment"));
assert(taskContext.includes("Integration test task"));
assert(taskContext.includes("bridge owns Paperclip lifecycle operations"));
assert.equal(await readFile(path.join(driveRoot,"rool-drive","paperclip","STA-99","shared","instructions","TOOLS.md"),"utf8"),"# Tools\nDo useful work.\n");
assert((await readFile(path.join(driveRoot,"rool-drive","paperclip","STA-99","shared","skills","paperclip","SKILL.md"),"utf8")).includes("Paperclip operating procedure"));
assert.equal(await readFile(path.join(driveRoot,"rool-drive","paperclip","STA-99","runs","run-1","attachments","01-evidence.txt"),"utf8"),"ATTACHMENT EVIDENCE\n");

const ctx2={...ctx1,runId:"run-2",runtime:{...ctx1.runtime,sessionParams:r1.sessionParams,sessionDisplayId:r1.sessionDisplayId},context:{taskId:"task-1",wakeReason:"comment",wakeCommentId:"c1"}};
const r2=await module.execute(ctx2);
assert.equal(r2.exitCode,0,JSON.stringify(r2,null,2));
assert.equal(r2.sessionParams.conversationId,r1.sessionParams.conversationId);
const state2=JSON.parse(await readFile(statePath,"utf8"));
assert.equal(state2.prompts.length,2);
assert(state2.prompts[1].prompt.includes("[PAPERCLIP-RUN:run-2]"));

const retry={...ctx2,runId:"run-2",runtime:{...ctx2.runtime,sessionParams:r2.sessionParams}};
const rRetry=await module.execute(retry);
assert.equal(rRetry.exitCode,0,JSON.stringify(rRetry,null,2));
const stateRetry=JSON.parse(await readFile(statePath,"utf8"));
assert.equal(stateRetry.prompts.length,2,"same Paperclip run must not submit a duplicate Rool prompt");

const fresh={...ctx2,runId:"run-3",runtime:{...ctx2.runtime,sessionParams:r2.sessionParams},context:{taskId:"task-1",wakeReason:"manual",forceFreshSession:true}};
const rFresh=await module.execute(fresh);
assert.equal(rFresh.exitCode,0,JSON.stringify(rFresh,null,2));
assert.notEqual(rFresh.sessionParams.conversationId,r2.sessionParams.conversationId,"forceFreshSession must create a new Rool conversation");
const stateFresh=JSON.parse(await readFile(statePath,"utf8"));
assert.equal(stateFresh.prompts.length,3);

const structuredLine=logs1.flatMap(x=>x.text.split(/\r?\n/)).find(line=>line.startsWith("@@PAPERCLIP_ROOL@@") && line.includes('"type":"result"'));
assert(structuredLine);
const parsed=parser.parseStdoutLine(structuredLine,"2026-10-05T00:00:00Z");
assert.equal(parsed[0].kind,"result");
assert.equal(parsed[0].isError,false);

assert(calls.some(c=>c.method==="POST" && c.url==="/api/issues/task-1/checkout"));
assert(calls.some(c=>c.method==="POST" && c.url==="/api/issues/task-1/interactions"));
assert(calls.some(c=>c.method==="PATCH" && c.url==="/api/issues/task-1"));

console.log("PASS: adapter capabilities, remote Test Environment probe, managed instructions transport, skill transport, issue attachment transport, rich task context, session resume, same-run idempotency, force-fresh session, Paperclip lifecycle persistence and UI parser.");

await new Promise(resolve=>server.close(resolve));
await rm(tmp,{recursive:true,force:true});
