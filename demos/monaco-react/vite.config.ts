import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

const SERVER_HOST = '127.0.0.1';
const SERVER_PORT = 12520;

export default defineConfig({
	server: { host: SERVER_HOST, port: SERVER_PORT },
  plugins: [react()],
});
