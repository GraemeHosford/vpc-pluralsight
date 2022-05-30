#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { VpcPluralsightStack } from '../lib/vpc-pluralsight-stack';

const app = new cdk.App();
new VpcPluralsightStack(app, 'VpcPluralsightStack');
