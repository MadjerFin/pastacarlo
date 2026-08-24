import WaitingRoom from './components/WaitingRoom';
import EntryPage from './components/EntryPage';

const style = document.createElement('style');
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);

export default function App() {
  const path = window.location.pathname;
  if (path === '/entrar') return <EntryPage />;
  return <WaitingRoom />;
}
