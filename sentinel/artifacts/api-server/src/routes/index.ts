import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sentinelRouter from "./sentinel";
import { ownerAuthRouter } from "../lib/owner-auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ownerAuthRouter);
router.use(sentinelRouter);

export default router;
