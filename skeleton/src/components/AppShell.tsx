import { Outlet } from 'react-router-dom';
import { useDataset } from '@criblio/app-utils/dataset';
import Sidebar from './Sidebar';
import s from './AppShell.module.css';

export default function AppShell() {
  const dataset = useDataset();
  return (
    <div className={s.shell}>
      <Sidebar />
      <main className={s.main}>
        {/* Keyed on the dataset so every page remounts when it changes. */}
        <Outlet key={dataset} />
      </main>
    </div>
  );
}
