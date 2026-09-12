import { mount } from 'svelte';
import App from './App.svelte';
import { request as fetch, localPath } from './request.js';
import './tokens.css';

const target = document.getElementById('app');
if (!target) throw new Error('Handover shell: #app missing');
// Only a 401 means "show the login form"; an unavailable ping must not masquerade as signed out.
const res = await fetch('/admin/api/ping');
// The login has no session to ask an endpoint with, so the route wrote the sign-in methods here.
const methods = JSON.parse(target.dataset.methods || '{}');
mount(App, {
  target,
  props: {
    session: res.ok ? await res.json() : res.status === 401 ? null : undefined,
    path: localPath(location.pathname),
    query: location.search,
    methods,
  },
});
