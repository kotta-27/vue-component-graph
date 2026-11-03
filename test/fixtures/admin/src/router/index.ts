import { createRouter, createWebHistory } from 'vue-router'
import home from './modules/home'
import perm from './modules/perm'
export default createRouter({ history: createWebHistory(), routes: [...home, ...perm] })
