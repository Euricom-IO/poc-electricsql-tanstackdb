// web2 reads directly from the ElectricSQL sync layer (the shape HTTP API).
// The Electric service is exposed on host port 3010 by docker-compose.
export const ELECTRIC_URL = import.meta.env.VITE_ELECTRIC_URL ?? 'http://localhost:3010/v1/shape';
