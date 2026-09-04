export const TILE_LAYERS = {
  clean: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    options: {
      maxNativeZoom: 19,
      maxZoom: 22,
      crossOrigin: true,
      attribution: '&copy; CartoDB Voyager (Mapa Limpio)'
    },
    label: 'Mapa Limpio',
    icon: 'fa-solid fa-layer-group'
  },
  detailed: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      maxNativeZoom: 19,
      maxZoom: 22,
      crossOrigin: true,
      attribution: '&copy; OpenStreetMap (Mapa Detallado)'
    },
    label: 'Mapa Detallado',
    icon: 'fa-solid fa-map-location-dot'
  },
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: {
      maxNativeZoom: 19,
      maxZoom: 22,
      crossOrigin: true,
      attribution: '&copy; CartoDB Dark'
    },
    label: 'Mapa Oscuro',
    icon: 'fa-solid fa-moon'
  }
};

export const MAP_DEFAULT_CENTER = [-11.502289, -77.205444];
export const MAP_DEFAULT_ZOOM = 16;
export const MAP_MAX_ZOOM = 22;

export const FAULT_CAUSES = [
  { id: 'HUMEDAD', label: 'HUMEDAD', color: '#00BCD4', textColor: '#ffffff' },
  { id: 'CORROSIÓN', label: 'CORROSIÓN', color: '#E65100', textColor: '#ffffff' },
  { id: 'ENVEJECIMIENTO', label: 'ENVEJECIMIENTO', color: '#8E24AA', textColor: '#ffffff' },
  { id: 'DAÑO PROPIO', label: 'DAÑO PROPIO', color: '#F57C00', textColor: '#ffffff' },
  { id: 'DAÑO DE TERCEROS', label: 'DAÑO DE TERCEROS', color: '#D32F2F', textColor: '#ffffff' },
  { id: 'SOBRECARGA', label: 'SOBRECARGA', color: '#FBC02D', textColor: '#000000' },
  { id: 'QUEMADO / CALCINADO', label: 'QUEMADO / CALCINADO', color: '#37474F', textColor: '#ffffff' },
  { id: 'CORTOCIRCUITO', label: 'CORTOCIRCUITO', color: '#2E7D32', textColor: '#ffffff' },
  { id: 'NO DETERMINADO', label: 'NO DETERMINADO', color: '#0288D1', textColor: '#ffffff' },
];

export const DEFAULT_CAUSE_COLOR = { id: 'OTRO', label: 'OTRO / DIFERENTE', color: '#78909C', textColor: '#ffffff' };

export function getCauseCategory(causaRaw) {
  if (!causaRaw || typeof causaRaw !== 'string') return DEFAULT_CAUSE_COLOR;
  
  const clean = causaRaw.trim().toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  
  if (clean.includes('HUMEDAD') || clean.includes('AGUA') || clean.includes('FILTRACION')) {
    return FAULT_CAUSES[0]; // HUMEDAD
  }
  if (clean.includes('CORROSION') || clean.includes('OXIDO') || clean.includes('SULFATADO')) {
    return FAULT_CAUSES[1]; // CORROSIÓN
  }
  if (clean.includes('ENVEJECIMIENTO') || clean.includes('FATIGA') || clean.includes('VIDA UTIL')) {
    return FAULT_CAUSES[2]; // ENVEJECIMIENTO
  }
  if (clean.includes('PROPIO') || clean.includes('OPERACION') || clean.includes('FABRICA')) {
    return FAULT_CAUSES[3]; // DAÑO PROPIO
  }
  if (clean.includes('TERCERO') || clean.includes('EXCAVACION') || clean.includes('CHOQUE') || clean.includes('VANDALISMO') || clean.includes('EXTERNA')) {
    return FAULT_CAUSES[4]; // DAÑO DE TERCEROS
  }
  if (clean.includes('SOBRECARGA') || clean.includes('EXCESO') || clean.includes('PICO')) {
    return FAULT_CAUSES[5]; // SOBRECARGA
  }
  if (clean.includes('QUEMADO') || clean.includes('CALCINADO') || clean.includes('FUEGO') || clean.includes('INCENDIO')) {
    return FAULT_CAUSES[6]; // QUEMADO / CALCINADO
  }
  if (clean.includes('CORTO') || clean.includes('CIRCUITO') || clean.includes('ARCO')) {
    return FAULT_CAUSES[7]; // CORTOCIRCUITO
  }
  if (clean.includes('NO DETERMINADO') || clean.includes('POR DETERMINAR') || clean.includes('PENDIENTE') || clean.includes('INVESTIGACION') || clean.includes('POR EVALUAR')) {
    return FAULT_CAUSES[8]; // NO DETERMINADO
  }
  
  return DEFAULT_CAUSE_COLOR;
}

