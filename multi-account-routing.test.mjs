import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSession} from './catalog.mjs';
const data={accounts:[{accountId:'first',codexHome:'/profile/first'},{accountId:'second',codexHome:'/profile/second'}],sessions:[{id:'first::same-id',threadId:'same-id',accountId:'first'},{id:'second::same-id',threadId:'same-id',accountId:'second'},{id:'second::unique-id',threadId:'unique-id',accountId:'second'}]};
test('duplicate UUID across accounts is rejected before a mutation can be routed',()=>assert.throws(()=>resolveSession('same-id',data),/multiple accounts/));
test('qualified IDs route duplicate UUIDs to the requested account',()=>{
 assert.equal(resolveSession('second::same-id',data).account.codexHome,'/profile/second');
 assert.equal(resolveSession('first::same-id',data).account.codexHome,'/profile/first');
});
test('unique legacy UUID remains compatible; unknown and empty IDs cannot fall back',()=>{
 assert.equal(resolveSession('unique-id',data).account.accountId,'second');
 assert.throws(()=>resolveSession('missing',data),/Unknown/);
 assert.throws(()=>resolveSession('',data),/Select/);
});
