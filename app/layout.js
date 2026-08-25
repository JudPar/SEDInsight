import './globals.css';
import AuthGate from '@/components/AuthGate';

export const metadata = {
  title: 'GEOPLUZ Emergencias - Análisis de Reparaciones',
  description: 'Plataforma de seguimiento y análisis de reparaciones de emergencia en subestaciones de distribución eléctrica',
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <head>
        {/* FontAwesome CDN */}
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
        {/* Google Fonts - Inter */}
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body><AuthGate>{children}</AuthGate></body>
    </html>
  );
}
