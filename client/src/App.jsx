import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import MonthView from './pages/MonthView';
import DayDetail from './pages/DayDetail';
import BaselineView from './pages/BaselineView';
import './App.css';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/month/:month" element={<MonthView />} />
        <Route path="/day/:date" element={<DayDetail />} />
        <Route path="/baseline/:name" element={<BaselineView />} />
      </Routes>
    </BrowserRouter>
  );
}
