import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planCliRepair, repairCliMetadata } from "./repair-cli.mjs";
const providerId = "account:bigmodel-individual-coding-plan";
const key = `account-provider:coding-plan:${providerId}:account:123:api-key`;
const builtin = { config: { providerConfigRules: { providerRules: [{providerId,
  config:{access:{mode:"individual-coding-plan"},builtinModelIds:["GLM-5.3"]}}] } } };
const personal = () => ({schemaVersion:1,config:{providerConfigRules:{providerRules:[]},modelConfigRules:{},other:undefined}});
test("requires unique existing credentials; never creates a new provider or key",()=>{
 assert.throws(()=>planCliRepair({},personal(),builtin),/唯一/);
 assert.throws(()=>planCliRepair({[key]:"ciphertext",[key.replace("123","456")]:"other"},personal(),builtin),/唯一/);
 const p=planCliRepair({[key]:"ciphertext"},personal(),builtin);
 assert.equal(p.addIdentity,true);assert.equal(p.addDefault,true);
});
test("preserves explicit model and existing identity",()=>{
 const p=personal();p.config.defaultModelSelection={providerId,modelId:"GLM-5.3-Flash",options:{reasoningLevel:"low"}};
 const plan=planCliRepair({[key]:"ciphertext",[`account-provider:${providerId}:identity`]:"existing"},p,builtin);
 assert.equal(plan.addIdentity,false);assert.equal(plan.addDefault,false);
 assert.deepEqual(plan.selection,p.config.defaultModelSelection);
});
test("dry run, additive writes, backups, idempotence and official lock exclusion",()=>{
 const root=mkdtempSync(join(tmpdir(),"zcode-repair-")), dir=join(root,".zcode","v2");mkdirSync(dir,{recursive:true});
 const credentialPath=join(dir,"credentials.json"),personalPath=join(dir,"provider_config.json"),builtinPath=join(root,"builtin.json");
 writeFileSync(credentialPath,JSON.stringify({[key]:"enc:v1:existing-ciphertext",unrelated:"preserved"}));
 const config=personal();config.config.providerOrder=["keep"];
 writeFileSync(personalPath,JSON.stringify(config));writeFileSync(builtinPath,JSON.stringify(builtin));
 const env={ZCODE_DATA_BASE_DIR:root};
 const original=readFileSync(credentialPath,"utf8");
 const dry=repairCliMetadata({env,builtinPath});assert.equal(dry.applied,false);
 assert.equal(readFileSync(credentialPath,"utf8"),original);
 mkdirSync(`${credentialPath}.lock`);
 assert.throws(()=>repairCliMetadata({env,builtinPath,apply:true}),/EEXIST/);
 assert.equal(readFileSync(credentialPath,"utf8"),original);
 // Remove our empty test lock, no recursive cleanup.
 rmdirSync(`${credentialPath}.lock`);
 const repaired=repairCliMetadata({env,builtinPath,apply:true});
 assert.equal(repaired.backups.length,2);assert.ok(repaired.backups.every(existsSync));
 const credentials=JSON.parse(readFileSync(credentialPath,"utf8"));
 assert.equal(credentials[key],"enc:v1:existing-ciphertext");assert.equal(credentials.unrelated,"preserved");
 assert.ok(credentials[`account-provider:${providerId}:identity`].startsWith("enc:v1:"));
 const after=JSON.parse(readFileSync(personalPath,"utf8"));
 assert.deepEqual(after.config.providerOrder,["keep"]);
 assert.deepEqual(after.config.defaultModelSelection,{providerId,modelId:"GLM-5.3"});
 assert.deepEqual(repairCliMetadata({env,builtinPath,apply:true}).backups,[]);
 assert.equal(existsSync(`${credentialPath}.lock`),false);
 writeFileSync(credentialPath,'invalid MOCK_PRIVATE_VALUE');
 assert.throws(()=>repairCliMetadata({env,builtinPath,apply:true}),e=>
   e.message.includes('JSON 无效') && !e.message.includes('MOCK_PRIVATE_VALUE'));
 assert.equal(readFileSync(credentialPath,'utf8'),'invalid MOCK_PRIVATE_VALUE');
 assert.equal(existsSync(`${credentialPath}.lock`),false);
});
