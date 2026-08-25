import { mount } from 'svelte';
import App from './App.svelte';
import './tokens.css';

const target = document.getElementById('app');
if (!target) throw new Error('Handover shell: #app missing');
// A 401 means "show the login form"; anything else carries who is signed in and what they may see.
const res = await fetch('/admin/api/ping');
mount(App, {
  target,
  props: { session: res.ok ? await res.json() : null, path: location.pathname },
});
