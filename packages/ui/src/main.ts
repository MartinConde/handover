import { mount } from 'svelte';
import App from './App.svelte';
import { request as fetch, localPath } from './request.js';
import './tokens.css';

const target = document.getElementById('app');
if (!target) throw new Error('Handover shell: #app missing');
// A 401 means "show the login form"; anything else carries who is signed in and what they may see.
const res = await fetch('/admin/api/ping');
// The login has no session to ask an endpoint with, so the route wrote the sign-in methods here.
const methods = JSON.parse(target.dataset.methods || '{}');
mount(App, {
  target,
  props: {
    session: res.ok ? await res.json() : null,
    path: localPath(location.pathname),
    query: location.search,
    methods,
  },
});
