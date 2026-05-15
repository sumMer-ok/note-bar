export function mapCanvasColorToCSSVar(
    canvasColor: string | undefined,
    fallback = 'var(--color-accent)'
): string {
    if (!canvasColor) return fallback;
    const colorMap: Record<string, string> = {
        '1': 'var(--color-red)',
        '2': 'var(--color-orange)',
        '3': 'var(--color-yellow)',
        '4': 'var(--color-green)',
        '5': 'var(--color-cyan)',
        '6': 'var(--color-purple)',
        red: 'var(--color-red)',
        orange: 'var(--color-orange)',
        yellow: 'var(--color-yellow)',
        green: 'var(--color-green)',
        cyan: 'var(--color-cyan)',
        blue: 'var(--color-blue)',
        purple: 'var(--color-purple)',
        pink: 'var(--color-pink)',
        gray: 'var(--color-base-60)',
        grey: 'var(--color-base-60)',
        white: 'var(--color-base-00)',
        black: 'var(--color-base-100)',
    };
    return colorMap[canvasColor.toLowerCase()] || canvasColor;
}

export function getColorWithOpacity(cssVar: string, opacity = 0.1): string {
    return `color-mix(in srgb, ${cssVar} ${opacity * 100}%, transparent)`;
}

export function isValidCanvasColor(color: string | undefined): boolean {
    if (!color) return false;
    const validColors = ['1', '2', '3', '4', '5', '6', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'];
    return validColors.includes(color.toLowerCase());
}
