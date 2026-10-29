"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes"

function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}

const noop = () => () => {}

/** Botón sol/luna para cambiar entre modo claro y modo noche. */
function ThemeToggle({ className = "" }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  // El tema solo se conoce en el navegador: hasta entonces se pinta un hueco del mismo tamaño.
  const mounted = React.useSyncExternalStore(noop, () => true, () => false)
  const dark = resolvedTheme === "dark"
  if (!mounted) return <span className={`theme-toggle ${className}`} aria-hidden />
  return (
    <button
      type="button"
      className={`theme-toggle ${className}`}
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "Cambiar a modo claro" : "Cambiar a modo noche"}
      title={dark ? "Modo claro" : "Modo noche"}
    >
      {dark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
    </button>
  )
}

export { ThemeProvider, ThemeToggle }
