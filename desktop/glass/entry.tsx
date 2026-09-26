import { createRoot } from 'react-dom/client';
import { Capsule } from './capsule';
import { Appearance } from './appearance';
import './ui.css';
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).get('role') === 'orb' ? <Capsule/> : <Appearance/>);
