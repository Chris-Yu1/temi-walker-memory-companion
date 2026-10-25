import { ModelADriver } from './model-a.driver';
import { ModelBDriver } from './model-b.driver';
import { IRobotOutput } from './robot-output.interface';
import { TemiV3Driver } from './temi-v3.driver';
import { WalkerDriver } from './walker.driver';

export class RobotDriverFactory {
  static create(robotId: string): IRobotOutput {
    const normalizedRobotId = robotId.toLowerCase();

    if (normalizedRobotId.includes('temi-v3')) {
      return new TemiV3Driver();
    }

    if (normalizedRobotId.includes('walker')) {
      return new WalkerDriver();
    }

    if (normalizedRobotId.includes('model-b')) {
      return new ModelBDriver();
    }

    if (normalizedRobotId.includes('model-a')) {
      return new ModelADriver();
    }

    throw new Error(`Unsupported robot model: ${robotId}`);
  }
}
