import { mount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Handover shell: #app missing');
// Phase 0 password gate: a 401 from the API means "show the login form".
const res = await fetch('/admin/api/ping');
mount(App, { target, props: { authed: res.ok } });
