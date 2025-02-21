import * as cxapi from '@aws-cdk/cx-api';
import * as AWS from 'aws-sdk';
import { ListStackResources } from './common';

export class CfnEvaluationException extends Error {}

export interface EvaluateCloudFormationTemplateProps {
  readonly stackArtifact: cxapi.CloudFormationStackArtifact;
  readonly parameters: { [parameterName: string]: string };
  readonly account: string;
  readonly region: string;
  readonly partition: string;
  readonly urlSuffix: string;

  readonly listStackResources: ListStackResources;
}

export class EvaluateCloudFormationTemplate {
  private readonly stackResources: ListStackResources;
  private readonly context: { [k: string]: string };
  private readonly account: string;
  private readonly region: string;
  private readonly partition: string;

  constructor(props: EvaluateCloudFormationTemplateProps) {
    this.stackResources = props.listStackResources;
    this.context = {
      'AWS::AccountId': props.account,
      'AWS::Region': props.region,
      'AWS::Partition': props.partition,
      'AWS::URLSuffix': props.urlSuffix,
      ...props.parameters,
    };
    this.account = props.account;
    this.region = props.region;
    this.partition = props.partition;
  }

  public async findPhysicalNameFor(logicalId: string): Promise<string | undefined> {
    const stackResources = await this.stackResources.listStackResources();
    return stackResources.find(sr => sr.LogicalResourceId === logicalId)?.PhysicalResourceId;
  }

  public async evaluateCfnExpression(cfnExpression: any): Promise<any> {
    const self = this;
    class CfnIntrinsics {
      public evaluateIntrinsic(intrinsic: Intrinsic): any {
        const intrinsicFunc = (this as any)[intrinsic.name];
        if (!intrinsicFunc) {
          throw new CfnEvaluationException(`CloudFormation function ${intrinsic.name} is not supported`);
        }

        const argsAsArray = Array.isArray(intrinsic.args) ? intrinsic.args : [intrinsic.args];

        return intrinsicFunc.apply(this, argsAsArray);
      }

      async 'Fn::Join'(separator: string, args: any[]): Promise<string> {
        const evaluatedArgs = await self.evaluateCfnExpression(args);
        return evaluatedArgs.join(separator);
      }

      async 'Fn::Split'(separator: string, args: any): Promise<string> {
        const evaluatedArgs = await self.evaluateCfnExpression(args);
        return evaluatedArgs.split(separator);
      }

      async 'Fn::Select'(index: number, args: any[]): Promise<string> {
        const evaluatedArgs = await self.evaluateCfnExpression(args);
        return evaluatedArgs[index];
      }

      async 'Ref'(logicalId: string): Promise<string> {
        const refTarget = await self.findRefTarget(logicalId);
        if (refTarget) {
          return refTarget;
        } else {
          throw new CfnEvaluationException(`Parameter or resource '${logicalId}' could not be found for evaluation`);
        }
      }

      async 'Fn::GetAtt'(logicalId: string, attributeName: string): Promise<string> {
        // ToDo handle the 'logicalId.attributeName' form of Fn::GetAtt
        const attrValue = await self.findGetAttTarget(logicalId, attributeName);
        if (attrValue) {
          return attrValue;
        } else {
          throw new CfnEvaluationException(`Attribute '${attributeName}' of resource '${logicalId}' could not be found for evaluation`);
        }
      }

      async 'Fn::Sub'(template: string, explicitPlaceholders?: { [variable: string]: string }): Promise<string> {
        const placeholders = explicitPlaceholders
          ? await self.evaluateCfnExpression(explicitPlaceholders)
          : {};

        return asyncGlobalReplace(template, /\${([^}]*)}/g, key => {
          if (key in placeholders) {
            return placeholders[key];
          } else {
            const splitKey = key.split('.');
            return splitKey.length === 1
              ? this.Ref(key)
              : this['Fn::GetAtt'](splitKey[0], splitKey.slice(1).join('.'));
          }
        });
      }
    }

    if (cfnExpression == null) {
      return cfnExpression;
    }

    if (Array.isArray(cfnExpression)) {
      return Promise.all(cfnExpression.map(expr => this.evaluateCfnExpression(expr)));
    }

    if (typeof cfnExpression === 'object') {
      const intrinsic = this.parseIntrinsic(cfnExpression);
      if (intrinsic) {
        return new CfnIntrinsics().evaluateIntrinsic(intrinsic);
      } else {
        const ret: { [key: string]: any } = {};
        for (const [key, val] of Object.entries(cfnExpression)) {
          ret[key] = await this.evaluateCfnExpression(val);
        }
        return ret;
      }
    }

    return cfnExpression;
  }

  private parseIntrinsic(x: any): Intrinsic | undefined {
    const keys = Object.keys(x);
    if (keys.length === 1 && (keys[0].startsWith('Fn::') || keys[0] === 'Ref')) {
      return {
        name: keys[0],
        args: x[keys[0]],
      };
    }
    return undefined;
  }

  private async findRefTarget(logicalId: string): Promise<string | undefined> {
    // first, check to see if the Ref is a Parameter who's value we have
    const parameterTarget = this.context[logicalId];
    if (parameterTarget) {
      return parameterTarget;
    }
    // if it's not a Parameter, we need to search in the current Stack resources
    return this.findGetAttTarget(logicalId);
  }

  private async findGetAttTarget(logicalId: string, attribute?: string): Promise<string | undefined> {
    const stackResources = await this.stackResources.listStackResources();
    const foundResource = stackResources.find(sr => sr.LogicalResourceId === logicalId);
    if (!foundResource) {
      return undefined;
    }
    // now, we need to format the appropriate identifier depending on the resource type,
    // and the requested attribute name
    return this.formatResourceAttribute(foundResource, attribute);
  }

  private formatResourceAttribute(resource: AWS.CloudFormation.StackResourceSummary, attribute: string | undefined): string | undefined {
    const physicalId = resource.PhysicalResourceId;

    // no attribute means Ref expression, for which we use the physical ID directly
    if (!attribute) {
      return physicalId;
    }

    const resourceTypeFormats = RESOURCE_TYPE_ATTRIBUTES_FORMATS[resource.ResourceType];
    if (!resourceTypeFormats) {
      throw new CfnEvaluationException(`We don't support attributes of the '${resource.ResourceType}' resource. This is a CDK limitation. ` +
        'Please report it at https://github.com/aws/aws-cdk/issues/new/choose');
    }
    const attributeFmtFunc = resourceTypeFormats[attribute];
    if (!attributeFmtFunc) {
      throw new CfnEvaluationException(`We don't support the '${attribute}' attribute of the '${resource.ResourceType}' resource. This is a CDK limitation. ` +
        'Please report it at https://github.com/aws/aws-cdk/issues/new/choose');
    }
    const service = this.getServiceOfResource(resource);
    const resourceTypeArnPart = this.getResourceTypeArnPartOfResource(resource);
    return attributeFmtFunc({
      partition: this.partition,
      service,
      region: this.region,
      account: this.account,
      resourceType: resourceTypeArnPart,
      resourceName: physicalId!,
    });
  }

  private getServiceOfResource(resource: AWS.CloudFormation.StackResourceSummary): string {
    return resource.ResourceType.split('::')[1].toLowerCase();
  }

  private getResourceTypeArnPartOfResource(resource: AWS.CloudFormation.StackResourceSummary): string {
    return resource.ResourceType.split('::')[2].toLowerCase();
  }
}

interface ArnParts {
  readonly partition: string;
  readonly service: string;
  readonly region: string;
  readonly account: string;
  readonly resourceType: string;
  readonly resourceName: string;
}

const RESOURCE_TYPE_ATTRIBUTES_FORMATS: { [type: string]: { [attribute: string]: (parts: ArnParts) => string } } = {
  'AWS::IAM::Role': { Arn: iamArnFmt },
  'AWS::IAM::User': { Arn: iamArnFmt },
  'AWS::IAM::Group': { Arn: iamArnFmt },
  'AWS::S3::Bucket': { Arn: s3ArnFmt },
  'AWS::Lambda::Function': { Arn: stdColonResourceArnFmt },
};

function iamArnFmt(parts: ArnParts): string {
  // we skip region for IAM resources
  return `arn:${parts.partition}:${parts.service}::${parts.account}:${parts.resourceType}/${parts.resourceName}`;
}

function s3ArnFmt(parts: ArnParts): string {
  // we skip account, region and resourceType for S3 resources
  return `arn:${parts.partition}:${parts.service}:::${parts.resourceName}`;
}

function stdColonResourceArnFmt(parts: ArnParts): string {
  // this is a standard format for ARNs like: arn:aws:service:region:account:resourceType:resourceName
  return `arn:${parts.partition}:${parts.service}:${parts.region}:${parts.account}:${parts.resourceType}:${parts.resourceName}`;
}

interface Intrinsic {
  readonly name: string;
  readonly args: any;
}

async function asyncGlobalReplace(str: string, regex: RegExp, cb: (x: string) => Promise<string>): Promise<string> {
  if (!regex.global) { throw new Error('Regex must be created with /g flag'); }

  const ret = new Array<string>();
  let start = 0;
  while (true) {
    const match = regex.exec(str);
    if (!match) { break; }

    ret.push(str.substring(start, match.index));
    ret.push(await cb(match[1]));

    start = regex.lastIndex;
  }
  ret.push(str.substr(start));

  return ret.join('');
}
