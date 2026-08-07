import { Check, Laptop, Moon, Sun } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme, type Theme } from "@/theme/theme-provider";

const options: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "system", label: "System theme", icon: Laptop },
  { value: "light", label: "Light theme", icon: Sun },
  { value: "dark", label: "Dark theme", icon: Moon },
];

export function ThemeMenu() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const Icon = resolvedTheme === "dark" ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={buttonVariants({ variant: "ghost", size: "icon" })} aria-label="Choose color theme"><Icon /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Appearance</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {options.map((option) => {
            const OptionIcon = option.icon;
            return (
              <DropdownMenuItem key={option.value} onClick={() => setTheme(option.value)}>
                <OptionIcon />
                {option.label}
                {theme === option.value ? <Check className="ml-auto" /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
