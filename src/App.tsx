import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import ScrubPage from './pages/ScrubPage.js'
import PricingPage from './pages/PricingPage.js'
import DashboardPage from './pages/DashboardPage.js'
import LegalPage from './pages/LegalPage.js'
import Footer from './components/Footer.js'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ScrubPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/legal/:slug" element={<LegalPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Footer />
    </BrowserRouter>
  )
}
