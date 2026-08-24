import WaitingRoom from './components/WaitingRoom';
import EntryPage from './components/EntryPage';

const style = document.createElement('style');
style.textContent = `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
`;
document.head.appendChild(style);

export default function App() {
  const path = window.location.pathname;
  if (path === '/entrar') return <EntryPage />;
  return <WaitingRoom />;
}
