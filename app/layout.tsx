import type { Metadata } from "next"
import { Geist_Mono, Plus_Jakarta_Sans } from "next/font/google"

import "./globals.css"
import { ThemeProvider, ThemeToggle } from "@/components/theme-provider"
import { cn } from "@/lib/utils";

// Una sola familia, cercana y muy legible: los títulos usan sus pesos fuertes (700-800).
// Next solo admite una carga por fuente: --font-heading apunta a esta misma en globals.css.
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-sans", weight: ["400", "500", "600", "700", "800"] })

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export const metadata: Metadata = {
  title: "El tiempo en tus ciudades",
  description: "Descarga el tiempo horario de cinco ciudades españolas desde Open-Meteo, revísalo y guárdalo en Supabase en tres pasos.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="es"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, "font-sans", jakarta.variable)}
    >
      <body>
        {/* Olas decorativas del fondo (solo CSS) */}
        <div className="bg-waves" aria-hidden>
          <div className="wave" />
          <div className="wave" />
          <div className="wave" />
        </div>
        <ThemeProvider>
          {children}
          {/* Botón flotante abajo a la derecha para cambiar entre modo claro y modo noche */}
          <ThemeToggle />
        </ThemeProvider>
      </body>
    </html>
  )
}
