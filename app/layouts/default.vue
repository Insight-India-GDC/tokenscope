<template>
  <div class="min-h-screen flex flex-col bg-paper">
    <!-- Skip link (WCAG 2.4.1), the same one the admin layout carries: first in
         the tab order, hidden until focused, jumps past the header nav. -->
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-md focus:bg-brand-harmony focus:text-white focus:font-semibold"
    >Skip to content</a>
    <NavAppHeader />
    <!-- min-w-0 lets wide content scroll inside its own card instead of
         widening the page at 320px (WCAG 1.4.10 reflow). -->
    <main id="main-content" class="flex-1 min-w-0">
      <slot />
    </main>
    <NavAppFooter />
  </div>
</template>
